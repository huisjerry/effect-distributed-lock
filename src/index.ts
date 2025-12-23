/**
 * Effect Distributed Lock
 *
 * A distributed lock library for Effect with pluggable backends.
 *
 * @example
 * ```ts
 * import { DistributedMutex, RedisBacking } from "effect-distributed-lock";
 * import { Effect } from "effect";
 * import Redis from "ioredis";
 *
 * const redis = new Redis(process.env.REDIS_URL);
 *
 * const program = Effect.gen(function* () {
 *   // Create a mutex for a specific resource
 *   const mutex = yield* DistributedMutex.make("my-resource-lock", {
 *     ttl: "30 seconds",
 *     acquireTimeout: "10 seconds",
 *   });
 *
 *   // Use the lock
 *   yield* mutex.withLock(
 *     Effect.gen(function* () {
 *       // Critical section - only one process can be here at a time
 *       yield* doSomethingExclusive();
 *     })
 *   );
 * });
 *
 * program.pipe(
 *   Effect.provide(RedisBacking.layer(redis)),
 *   Effect.runPromise
 * );
 * ```
 *
 * @module
 */

// Backing interface
export * as Backing from "./Backing.js";
export { DistributedLockBacking, LockBackingError } from "./Backing.js";

// Core module (namespace with types and functions)
export * as DistributedMutex from "./DistributedMutex.js";

// Errors
export { LockLostError } from "./Errors.js";

// Redis backing
export * as RedisBacking from "./RedisBacking.js";
