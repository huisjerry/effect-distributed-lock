import { Duration, Effect, Layer, Option } from "effect";
import { Redis } from "ioredis";
import { DistributedLockBacking, LockBackingError } from "./Backing.js";

/**
 * Lua script for atomic lock acquisition.
 * SET key value NX PX ttl - set only if not exists, with TTL
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local holderId = ARGV[1]
local ttlMs = tonumber(ARGV[2])

local result = redis.call('SET', key, holderId, 'NX', 'PX', ttlMs)
if result then
  return 1
else
  return 0
end
`;

/**
 * Lua script for atomic lock release.
 * Only deletes if we are the current holder.
 */
const RELEASE_SCRIPT = `
local key = KEYS[1]
local holderId = ARGV[1]

local currentHolder = redis.call('GET', key)
if currentHolder == holderId then
  redis.call('DEL', key)
  return 1
else
  return 0
end
`;

/**
 * Lua script for atomic TTL refresh.
 * Only refreshes if we are the current holder.
 */
const REFRESH_SCRIPT = `
local key = KEYS[1]
local holderId = ARGV[1]
local ttlMs = tonumber(ARGV[2])

local currentHolder = redis.call('GET', key)
if currentHolder == holderId then
  redis.call('PEXPIRE', key, ttlMs)
  return 1
else
  return 0
end
`;

/**
 * Create a Redis-backed distributed lock backing layer.
 *
 * @param redis - An ioredis client instance
 * @param keyPrefix - Optional prefix for all keys (default: "dlock:")
 */
export const layer = (
  redis: Redis,
  keyPrefix = "dlock:"
): Layer.Layer<DistributedLockBacking> => {
  const prefixKey = (key: string) => `${keyPrefix}${key}`;

  const tryAcquire = (
    key: string,
    holderId: string,
    ttl: Duration.Duration
  ): Effect.Effect<boolean, LockBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await redis.eval(
          ACQUIRE_SCRIPT,
          1,
          prefixKey(key),
          holderId,
          Duration.toMillis(ttl).toString()
        );
        return result === 1;
      },
      catch: (cause) =>
        new LockBackingError({ operation: "tryAcquire", cause }),
    });

  const release = (
    key: string,
    holderId: string
  ): Effect.Effect<boolean, LockBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await redis.eval(
          RELEASE_SCRIPT,
          1,
          prefixKey(key),
          holderId
        );
        return result === 1;
      },
      catch: (cause) => new LockBackingError({ operation: "release", cause }),
    });

  const refresh = (
    key: string,
    holderId: string,
    ttl: Duration.Duration
  ): Effect.Effect<boolean, LockBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await redis.eval(
          REFRESH_SCRIPT,
          1,
          prefixKey(key),
          holderId,
          Duration.toMillis(ttl).toString()
        );
        return result === 1;
      },
      catch: (cause) => new LockBackingError({ operation: "refresh", cause }),
    });

  const isLocked = (key: string): Effect.Effect<boolean, LockBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const exists = await redis.exists(prefixKey(key));
        return exists === 1;
      },
      catch: (cause) => new LockBackingError({ operation: "isLocked", cause }),
    });

  const getHolder = (
    key: string
  ): Effect.Effect<Option.Option<string>, LockBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const holder = await redis.get(prefixKey(key));
        return holder ? Option.some(holder) : Option.none();
      },
      catch: (cause) => new LockBackingError({ operation: "getHolder", cause }),
    });

  return Layer.succeed(DistributedLockBacking, {
    tryAcquire,
    release,
    refresh,
    isLocked,
    getHolder,
  });
};
