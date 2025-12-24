import { Data } from "effect";

/**
 * The permits were lost (TTL expired while we thought we held them)
 */
export class LockLostError extends Data.TaggedError("LockLostError")<{
  readonly key: string;
}> {
  get message() {
    return `Permits for "${this.key}" were lost (TTL expired or taken by another holder)`;
  }
}

/**
 * The lock failed to be acquired. This occurs when the lock is not aquired within the provided schedule.
 */
export class LockNotAcquiredError extends Data.TaggedError(
  "LockNotAcquiredError"
)<{
  readonly key: string;
}> {
  get message() {
    return `Lock for "${this.key}" was not acquired`;
  }
}
