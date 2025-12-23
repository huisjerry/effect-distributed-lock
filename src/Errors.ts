import { Data } from "effect";

/**
 * The lock was lost (TTL expired while we thought we held it)
 */
export class LockLostError extends Data.TaggedError("LockLostError")<{
  readonly key: string;
}> {
  get message() {
    return `Lock "${this.key}" was lost (TTL expired or taken by another holder)`;
  }
}

/**
 * Error from the backing store (Redis, etc.)
 */
export class MutexBackingError extends Data.TaggedError("MutexBackingError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  get message() {
    return `Backing store error during "${this.operation}": ${this.cause}`;
  }
}

/**
 * Internal error: lock not yet acquired (used for retry logic)
 * @internal
 */
export class NotYetAcquiredError extends Data.TaggedError(
  "NotYetAcquiredError"
)<{}> {}
