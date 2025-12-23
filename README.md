# effect-distributed-lock

*WARNING: This is still in active development, likely has bugs and is subject to change.*

A distributed mutex library for [Effect](https://effect.website/) with pluggable backends.

## Features

- **Scope-based resource management** — locks are automatically released when the scope closes
- **Automatic TTL refresh** — keeps locks alive while held, prevents deadlocks if holder crashes
- **Pluggable backends** — ships with Redis, easy to implement others (etcd, DynamoDB, etc.)
- **Configurable retry policies** — control polling interval, TTL, and backing failure retry behavior
- **Type-safe errors** — tagged errors for precise error handling

## Installation

```bash
npm install effect-distributed-lock effect
# or
bun add effect-distributed-lock effect

# For Redis backing (optional)
npm install ioredis
```

## Quick Start

```typescript
import { Effect } from "effect";
import Redis from "ioredis";
import { DistributedMutex, RedisBacking } from "effect-distributed-lock";

const redis = new Redis(process.env.REDIS_URL);
const RedisLayer = RedisBacking.layer(redis);

const program = Effect.gen(function* () {
  const mutex = yield* DistributedMutex.make("my-resource", {
    ttl: "10 seconds",
    refreshInterval: "3 seconds",
    acquireRetryInterval: "500 millis",
    backingFailureRetryPolicy: Schedule.exponential("100 millis")),
  });

  // Lock is held while effect runs, released automatically after
  yield* mutex.withLock(doExclusiveWork);
});

program.pipe(Effect.provide(RedisLayer), Effect.runPromise);
```

## API

### Creating a Mutex

```typescript
const mutex = yield* DistributedMutex.make(key, config);
```

| Config Option          | Type               | Default      | Description                                         |
| ---------------------- | ------------------ | ------------ | --------------------------------------------------- |
| `ttl`                  | `DurationInput`    | `30 seconds` | Lock TTL (auto-releases if holder crashes)          |
| `refreshInterval`      | `DurationInput`    | `ttl / 3`    | How often to refresh TTL while holding              |
| `acquireRetryInterval` | `DurationInput`    | `100ms`      | Polling interval when waiting to acquire            |
| `backingFailureRetryPolicy`   | `Schedule<void>`   | `100ms`      | Retry schedule for backing store failures           |

### Using the Mutex

#### `withLock` — Acquire, run, release

The simplest and recommended way. Acquires the lock (waiting indefinitely if needed), runs your effect, and releases when done:

```typescript
yield* mutex.withLock(myEffect);
```

#### `withLockIfAvailable` — Non-blocking acquire

Tries to acquire immediately without waiting. Returns `Option.some(result)` if successful, `Option.none()` if lock is held:

```typescript
const result = yield* mutex.withLockIfAvailable(myEffect);
if (Option.isSome(result)) {
  console.log("Got the lock!", result.value);
} else {
  console.log("Lock was busy, skipping");
}
```

#### `acquire` / `tryAcquire` — Manual scope control

For advanced use cases where you need explicit control over the lock lifecycle:

```typescript
yield* Effect.scoped(
  Effect.gen(function* () {
    const keepAliveFiber = yield* mutex.acquire; // Lock held until scope closes
    yield* doWork;
    // Lock automatically released + keepalive fiber interrupted here
  })
);
```

Both `acquire` and `tryAcquire` return the keepalive fiber that refreshes the lock TTL. Errors related to the keep alive (losing the lock or backing store failure) are propagated to the fiber.

#### `isLocked` — Check lock status

```typescript
const locked = yield* mutex.isLocked;
```

## Error Handling

All errors are tagged for precise handling with `Effect.catchTag`:

```typescript
yield* mutex.withLock(myEffect).pipe(
  Effect.catchTag("LockLostError", (e) =>
    Effect.log(`Lock was lost while held: ${e.key}`)
  ),
  Effect.catchTag("MutexBackingError", (e) =>
    Effect.log(`Redis error: ${e.message}`)
  )
);
```

| Error               | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `LockLostError`     | Lock TTL expired while we thought we held it         |
| `MutexBackingError` | Error from the backing store (Redis connection, etc) |

## Custom Backends

Implement the `DistributedMutexBacking` interface to use a different store:

```typescript
import { Duration, Layer } from "effect";
import { DistributedMutex } from "effect-distributed-lock";

const MyCustomBacking = Layer.succeed(DistributedMutex.DistributedMutexBacking, {
  tryAcquire: (key, holderId, ttl: Duration.Duration) => /* ... */,
  release: (key, holderId) => /* ... */,
  refresh: (key, holderId, ttl: Duration.Duration) => /* ... */,
  isLocked: (key) => /* ... */,
  getHolder: (key) => /* ... */,
});
```

## How It Works

1. **Acquire**: Atomically sets the lock key if not exists (Redis: `SET key value NX PX ttl`)
2. **Keepalive**: A background fiber refreshes the TTL periodically while the lock is held
3. **Release**: Atomically deletes the key only if we're still the holder (Lua script for atomicity)
4. **Crash safety**: If the holder crashes, the TTL expires and another process can acquire

## License

MIT
