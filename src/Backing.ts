import { Context, Data, Duration, Effect, Option } from "effect";

// =============================================================================
// Errors
// =============================================================================

/**
 * Error from the backing store (Redis, etc.)
 */
export class LockBackingError extends Data.TaggedError("LockBackingError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  get message() {
    return `Backing store error during "${this.operation}": ${this.cause}`;
  }
}

// =============================================================================
// Backing Service
// =============================================================================

/**
 * Low-level backing store interface for distributed lock operations.
 * Implementations handle the actual storage (Redis, etcd, DynamoDB, etc.)
 */
export interface DistributedLockBacking {
  /**
   * Try to acquire the lock. Returns true if acquired, false if already held.
   * Must set TTL on the lock.
   */
  readonly tryAcquire: (
    key: string,
    holderId: string,
    ttl: Duration.Duration
  ) => Effect.Effect<boolean, LockBackingError>;

  /**
   * Release the lock. Only succeeds if we are the current holder.
   * Returns true if released, false if we weren't the holder.
   */
  readonly release: (
    key: string,
    holderId: string
  ) => Effect.Effect<boolean, LockBackingError>;

  /**
   * Refresh the TTL on a lock we hold.
   * Returns true if refreshed, false if lock was lost.
   */
  readonly refresh: (
    key: string,
    holderId: string,
    ttl: Duration.Duration
  ) => Effect.Effect<boolean, LockBackingError>;

  /**
   * Check if the lock is currently held (by anyone).
   */
  readonly isLocked: (key: string) => Effect.Effect<boolean, LockBackingError>;

  /**
   * Get the current holder ID, if any.
   */
  readonly getHolder: (
    key: string
  ) => Effect.Effect<Option.Option<string>, LockBackingError>;
}

export const DistributedLockBacking =
  Context.GenericTag<DistributedLockBacking>(
    "@effect-distributed-lock/DistributedLockBacking"
  );
