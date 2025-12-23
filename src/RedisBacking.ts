import { Duration, Effect, Layer } from "effect";
import { Redis } from "ioredis";
import {
  DistributedSemaphoreBacking,
  SemaphoreBackingError,
} from "./Backing.js";

/**
 * Lua script for atomic semaphore acquisition.
 *
 * Uses a sorted set where:
 * - Each member is `holderId_permitIndex` (e.g., "abc123_0", "abc123_1")
 * - Score is the acquisition timestamp
 * - Expired entries are removed before checking capacity
 *
 * Arguments:
 * - KEYS[1]: the semaphore key
 * - ARGV[1]: limit (max permits)
 * - ARGV[2]: permits to acquire
 * - ARGV[3]: holderId
 * - ARGV[4]: ttlMs (lock timeout in ms)
 * - ARGV[5]: now (current timestamp in ms)
 *
 * Returns 1 if acquired, 0 if not enough permits available.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local permits = tonumber(ARGV[2])
local holderId = ARGV[3]
local ttlMs = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local expiredTimestamp = now - ttlMs

-- Remove expired entries
redis.call('zremrangebyscore', key, '-inf', expiredTimestamp)

-- Check if there's room for the requested permits
if (redis.call('zcard', key) + permits) <= limit then
  -- Add all permits with current timestamp
  local args = {}
  for i = 0, permits - 1 do
    table.insert(args, now)
    table.insert(args, holderId .. '_' .. i)
  end
  redis.call('zadd', key, unpack(args))
  redis.call('pexpire', key, ttlMs)
  return 1
else
  return 0
end
`;

/**
 * Lua script for atomic release.
 *
 * Removes all permits held by this holder.
 *
 * Arguments:
 * - KEYS[1]: the semaphore key
 * - ARGV[1]: permits to release
 * - ARGV[2]: holderId
 *
 * Returns the number of permits released.
 */
const RELEASE_SCRIPT = `
local key = KEYS[1]
local permits = tonumber(ARGV[1])
local holderId = ARGV[2]
local args = {}

for i = 0, permits - 1 do
  table.insert(args, holderId .. '_' .. i)
end

return redis.call('zrem', key, unpack(args))
`;

/**
 * Lua script for atomic TTL refresh.
 *
 * Updates the timestamp (score) for all permits held by this holder.
 * Returns 0 if the holder doesn't have any permits (lock was lost).
 *
 * Arguments:
 * - KEYS[1]: the semaphore key
 * - ARGV[1]: limit (for consistency, though not strictly needed for refresh)
 * - ARGV[2]: permits
 * - ARGV[3]: holderId
 * - ARGV[4]: ttlMs
 * - ARGV[5]: now
 *
 * Returns 1 if refreshed, 0 if permits were lost.
 */
const REFRESH_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local permits = tonumber(ARGV[2])
local holderId = ARGV[3]
local ttlMs = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local expiredTimestamp = now - ttlMs

-- Remove expired entries
redis.call('zremrangebyscore', key, '-inf', expiredTimestamp)

-- Check if we still hold the first permit (indicator that we still own it)
if redis.call('zscore', key, holderId .. '_0') then
  -- Update all permits with new timestamp
  local args = {}
  for i = 0, permits - 1 do
    table.insert(args, now)
    table.insert(args, holderId .. '_' .. i)
  end
  redis.call('zadd', key, unpack(args))
  redis.call('pexpire', key, ttlMs)
  return 1
else
  return 0
end
`;

/**
 * Lua script to get the current count of active permits.
 *
 * Arguments:
 * - KEYS[1]: the semaphore key
 * - ARGV[1]: ttlMs
 * - ARGV[2]: now
 *
 * Returns the number of active (non-expired) permits.
 */
const GET_COUNT_SCRIPT = `
local key = KEYS[1]
local ttlMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local expiredTimestamp = now - ttlMs

-- Remove expired entries
redis.call('zremrangebyscore', key, '-inf', expiredTimestamp)

return redis.call('zcard', key)
`;

/**
 * Create a Redis-backed distributed semaphore backing layer.
 *
 * **Important:** This implementation is for single-instance Redis only.
 * It does not implement the Redlock algorithm and should not be used with
 * Redis Cluster or Redis Sentinel for distributed locking guarantees.
 * For multi-instance Redis, consider implementing a Redlock-based backing.
 *
 * @param redis - An ioredis client instance (single instance, not cluster)
 * @param keyPrefix - Optional prefix for all keys (default: "dsem:")
 */
export const layer = (
  redis: Redis,
  keyPrefix = "dsem:"
): Layer.Layer<DistributedSemaphoreBacking> => {
  const prefixKey = (key: string) => `${keyPrefix}${key}`;

  const tryAcquire = (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number
  ): Effect.Effect<boolean, SemaphoreBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const now = Date.now();
        const result = await redis.eval(
          ACQUIRE_SCRIPT,
          1,
          prefixKey(key),
          limit.toString(),
          permits.toString(),
          holderId,
          Duration.toMillis(ttl).toString(),
          now.toString()
        );
        return result === 1;
      },
      catch: (cause) =>
        new SemaphoreBackingError({ operation: "tryAcquire", cause }),
    });

  const release = (
    key: string,
    holderId: string,
    permits: number
  ): Effect.Effect<number, SemaphoreBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await redis.eval(
          RELEASE_SCRIPT,
          1,
          prefixKey(key),
          permits.toString(),
          holderId
        );
        return result as number;
      },
      catch: (cause) =>
        new SemaphoreBackingError({ operation: "release", cause }),
    });

  const refresh = (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number
  ): Effect.Effect<boolean, SemaphoreBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const now = Date.now();
        const result = await redis.eval(
          REFRESH_SCRIPT,
          1,
          prefixKey(key),
          limit.toString(),
          permits.toString(),
          holderId,
          Duration.toMillis(ttl).toString(),
          now.toString()
        );
        return result === 1;
      },
      catch: (cause) =>
        new SemaphoreBackingError({ operation: "refresh", cause }),
    });

  const getCount = (
    key: string,
    ttl: Duration.Duration
  ): Effect.Effect<number, SemaphoreBackingError> =>
    Effect.tryPromise({
      try: async () => {
        const now = Date.now();
        const result = await redis.eval(
          GET_COUNT_SCRIPT,
          1,
          prefixKey(key),
          Duration.toMillis(ttl).toString(),
          now.toString()
        );
        return result as number;
      },
      catch: (cause) =>
        new SemaphoreBackingError({ operation: "getCount", cause }),
    });

  return Layer.succeed(DistributedSemaphoreBacking, {
    tryAcquire,
    release,
    refresh,
    getCount,
  });
};
