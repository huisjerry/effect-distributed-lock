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
 * Internal error: permits not yet acquired (used for retry logic)
 * @internal
 */
export class NotYetAcquiredError extends Data.TaggedError(
  "NotYetAcquiredError"
)<{}> {}
