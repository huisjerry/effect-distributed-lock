import { Context, Data, Duration, Effect } from "effect";

// =============================================================================
// Errors
// =============================================================================

/**
 * Error from the backing store (Redis, etc.)
 */
export class SemaphoreBackingError extends Data.TaggedError(
  "SemaphoreBackingError"
)<{
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
 * Low-level backing store interface for distributed semaphore operations.
 * Implementations handle the actual storage (Redis, etc.)
 *
 * The semaphore uses a sorted set model where:
 * - Each permit holder is stored with their acquisition timestamp as the score
 * - Expired entries are cleaned up automatically
 * - Multiple permits can be acquired atomically
 */
export interface DistributedSemaphoreBacking {
  /**
   * Try to acquire `permits` from a semaphore with the given `limit`.
   * Returns true if acquired, false if not enough permits available.
   *
   * The implementation should:
   * 1. Clean up expired entries (based on TTL)
   * 2. Check if there's room: currentCount + permits <= limit
   * 3. If so, add the permits with current timestamp
   */
  readonly tryAcquire: (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number
  ) => Effect.Effect<boolean, SemaphoreBackingError>;

  /**
   * Release `permits` held by this holder.
   * Returns the number of permits actually released.
   */
  readonly release: (
    key: string,
    holderId: string,
    permits: number
  ) => Effect.Effect<number, SemaphoreBackingError>;

  /**
   * Refresh the TTL on permits we hold.
   * Returns true if refreshed, false if permits were lost.
   */
  readonly refresh: (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number
  ) => Effect.Effect<boolean, SemaphoreBackingError>;

  /**
   * Get the number of permits currently held (in use).
   * Available permits = limit - getCount().
   */
  readonly getCount: (
    key: string,
    ttl: Duration.Duration
  ) => Effect.Effect<number, SemaphoreBackingError>;
}

export const DistributedSemaphoreBacking =
  Context.GenericTag<DistributedSemaphoreBacking>(
    "@effect-distributed-lock/DistributedSemaphoreBacking"
  );
