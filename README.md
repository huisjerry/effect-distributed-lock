# effect-distributed-lock

*WARNING: This is still in active development, possibly has bugs (distributed systems are hard!), and is subject to change.*

A distributed semaphore library for [Effect](https://effect.website/) with pluggable backends.

It's like the built in `Effect.Semaphore`, but asynchronously distributed across multiple processes/services!

## Features

- **Distributed semaphore** — control concurrent access across multiple processes/services
- **Scope-based resource management** — permits are automatically released when the scope closes
- **Automatic TTL refresh** — keeps permits alive while held, prevents deadlocks if holder crashes
- **Pluggable backends** — ships with Redis (single-instance), easy to implement others
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
import { Effect, Schedule } from "effect";
import Redis from "ioredis";
import { DistributedSemaphore, RedisBacking } from "effect-distributed-lock";

const redis = new Redis(process.env.REDIS_URL);
const RedisLayer = RedisBacking.layer(redis);

const program = Effect.gen(function* () {
  // Create a semaphore that allows 5 concurrent operations
  const sem = yield* DistributedSemaphore.make("my-resource", {
    limit: 5,
    ttl: "10 seconds",
    refreshInterval: "3 seconds",
    acquireRetryInterval: "500 millis",
    backingFailureRetryPolicy: Schedule.exponential("100 millis"),
  });

  // Acquire 2 permits, run effect, release automatically after
  yield* doWork.pipe(sem.withPermits(2));
});

program.pipe(Effect.provide(RedisLayer), Effect.runPromise);
```

## API

### Creating a Semaphore

```typescript
const sem = yield* DistributedSemaphore.make(key, config);
```

| Config Option                | Type             | Default      | Description                                |
| ---------------------------- | ---------------- | ------------ | ------------------------------------------ |
| `limit`                      | `number`         | `1`          | Max permits (1 = mutex behavior)           |
| `ttl`                        | `DurationInput`  | `30 seconds` | Permit TTL (auto-releases if holder crashes) |
| `refreshInterval`            | `DurationInput`  | `ttl / 3`    | How often to refresh TTL while holding     |
| `acquireRetryInterval`       | `DurationInput`  | `100ms`      | Polling interval when waiting to acquire   |
| `backingFailureRetryPolicy`  | `Schedule<void>` | `100ms`      | Retry schedule for backing store failures  |

### Using the Semaphore

#### `withPermits` — Acquire, run, release

The simplest and recommended way. Acquires permits (waiting if needed), runs your effect, and releases when done:

```typescript
// Acquire 2 permits out of limit
yield* myEffect.pipe(sem.withPermits(2));

// For mutex behavior (limit=1), use withPermits(1)
yield* criticalSection.pipe(mutex.withPermits(1));
```

#### `withPermitsIfAvailable` — Non-blocking acquire

Tries to acquire immediately without waiting. Returns `Option.some(result)` if successful, `Option.none()` if not enough permits:

```typescript
const result = yield* myEffect.pipe(sem.withPermitsIfAvailable(1));
if (Option.isSome(result)) {
  console.log("Got the permit!", result.value);
} else {
  console.log("No permits available, skipping");
}
```

#### `take` / `tryTake` — Manual scope control

For advanced use cases where you need explicit control over the permit lifecycle:

```typescript
yield* Effect.scoped(
  Effect.gen(function* () {
    const keepAliveFiber = yield* sem.take(2); // 2 permits held until scope closes
    yield* doWork;
    // Permits automatically released + keepalive fiber interrupted here
  })
);
```

Both `take` and `tryTake` return the keepalive fiber that refreshes the permit TTL. Errors from the keepalive (losing permits or backing store failure) are propagated through the fiber.

#### `currentCount` — Check held permits

```typescript
const held = yield* sem.currentCount; // Number of permits currently held
const available = sem.limit - held;   // Number of permits available
```

## Error Handling

All errors are tagged for precise handling with `Effect.catchTag`:

```typescript
yield* myEffect.pipe(
  sem.withPermits(1),
  Effect.catchTag("LockLostError", (e) =>
    Effect.log(`Permits were lost: ${e.key}`)
  ),
  Effect.catchTag("SemaphoreBackingError", (e) =>
    Effect.log(`Redis error: ${e.message}`)
  )
);
```

| Error                   | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `LockLostError`         | Permit TTL expired while we thought we held it       |
| `SemaphoreBackingError` | Error from the backing store (Redis connection, etc) |

## Redis Backing (Single-Instance Only)

The provided Redis backing is designed for **single-instance Redis only**. It does not implement the [Redlock algorithm](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) and should not be used with Redis Cluster or Redis Sentinel when you need strong distributed locking guarantees.

```typescript
import Redis from "ioredis";
import { RedisBacking } from "effect-distributed-lock";

// Single Redis instance
const redis = new Redis("redis://localhost:6379");
const RedisLayer = RedisBacking.layer(redis, "my-prefix:");
```

For multi-instance Redis deployments requiring Redlock, you'll need to implement a custom backing.

## Custom Backends

Implement the `DistributedSemaphoreBacking` interface to use a different store:

```typescript
import { Duration, Effect, Layer, Option } from "effect";
import { Backing, DistributedSemaphoreBacking } from "effect-distributed-lock";

const MyCustomBacking = Layer.succeed(DistributedSemaphoreBacking, {
  tryAcquire: (key, holderId, ttl, limit, permits) => 
    Effect.succeed(true), // Try to acquire permits
  
  release: (key, holderId, permits) => 
    Effect.succeed(permits), // Release permits, return count released
  
  refresh: (key, holderId, ttl, limit, permits) => 
    Effect.succeed(true), // Refresh TTL, return false if lost
  
  getCount: (key, ttl) => 
    Effect.succeed(0), // Return number of permits currently held
});
```

## How It Works

1. **Acquire**: Atomically adds permits to a sorted set if there's room (Redis: Lua script with `ZADD`)
2. **Keepalive**: A background fiber refreshes the TTL periodically by updating timestamps
3. **Release**: Atomically removes permits from the sorted set (Lua script with `ZREM`)
4. **Expiration**: Expired entries (based on TTL) are cleaned up on each operation
5. **Crash safety**: If the holder crashes, permits expire and become available

## License

MIT
