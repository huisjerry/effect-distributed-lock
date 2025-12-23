import { Duration, Effect, Fiber, Option, Schedule, Scope } from "effect";
import { DistributedLockBacking, LockBackingError } from "./Backing.js";
import { LockLostError, NotYetAcquiredError } from "./Errors.js";

// =============================================================================
// Mutex Configuration
// =============================================================================

export interface DistributedMutexConfig {
  /**
   * TTL for the lock. If the holder crashes, the lock auto-releases after this.
   * @default 30 seconds
   */
  readonly ttl?: Duration.DurationInput;

  /**
   * How often to refresh the TTL while holding the lock.
   * Should be less than TTL to avoid losing the lock.
   * @default 1/3 of TTL
   */
  readonly refreshInterval?: Duration.DurationInput;

  /**
   * How often to poll when waiting to acquire the lock.
   * @default 100ms
   */
  readonly acquireRetryInterval?: Duration.DurationInput;

  /**
   * How often to retry when a failure occurs.
   * This could happen when:
   * - Trying to acquire the lock
   * - Refreshing the TTL
   * - Releasing the lock
   */
  readonly backingFailureRetryPolicy?: Schedule.Schedule<void>;
}

const DEFAULT_TTL = Duration.seconds(30);
const DEFAULT_ACQUIRE_RETRY_INTERVAL = Duration.millis(100);
const DEFAULT_FAILURE_RETRY_POLICY = Schedule.spaced(
  DEFAULT_ACQUIRE_RETRY_INTERVAL
).pipe(Schedule.asVoid);

// =============================================================================
// Distributed Mutex Interface
// =============================================================================

/**
 * A distributed mutex that can be used across multiple processes/services.
 */
export interface DistributedMutex {
  /**
   * The key identifying this mutex in the backing store.
   */
  readonly key: string;

  /**
   * Acquire the lock, run the effect, then release.
   * If acquisition fails within timeout, returns AcquireTimeoutError.
   * The lock TTL is refreshed automatically while the effect runs.
   */
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | LockLostError | LockBackingError, R>;

  /**
   * Try to acquire the lock immediately without waiting.
   * Returns Some(result) if lock was acquired and effect ran,
   * None if lock was not available.
   */
  readonly withLockIfAvailable: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<Option.Option<A>, E | LockLostError | LockBackingError, R>;

  /**
   * Acquire the lock, waiting if necessary.
   * The lock is held until the scope is closed.
   * The lock TTL is refreshed automatically while held.
   *
   * @returns The fiber that refreshes the lock hold. Its lifetime is tied to the scope.
   * When the scope closes, the fiber is interrupted and the lock is released.
   */
  readonly acquire: Effect.Effect<
    Fiber.Fiber<void, LockLostError | LockBackingError>,
    LockLostError | LockBackingError,
    Scope.Scope
  >;

  /**
   * Try to acquire immediately without waiting.
   * Returns Some(void) if acquired (lock held until scope closes),
   * None if lock was not available.
   *
   * @returns The fiber that refreshes the lock hold. Its lifetime is tied to the scope.
   * When the scope closes, the fiber is interrupted and the lock is released.
   */
  readonly tryAcquire: Effect.Effect<
    Option.Option<Fiber.Fiber<void, LockLostError | LockBackingError>>,
    LockLostError | LockBackingError,
    Scope.Scope
  >;

  /**
   * Check if the lock is currently held.
   */
  readonly isLocked: Effect.Effect<boolean, LockBackingError>;
}

// =============================================================================
// Factory
// =============================================================================

type FullyResolvedConfig = {
  ttl: Duration.Duration;
  refreshInterval: Duration.Duration;
  acquireRetryInterval: Duration.Duration;
  backingFailureRetryPolicy: Schedule.Schedule<void>;
};

function fullyResolveConfig(
  config: DistributedMutexConfig
): FullyResolvedConfig {
  const ttl = config.ttl ? Duration.decode(config.ttl) : DEFAULT_TTL;
  const refreshInterval = config.refreshInterval
    ? Duration.decode(config.refreshInterval)
    : Duration.millis(Duration.toMillis(ttl) / 3);
  const acquireRetryInterval = config.acquireRetryInterval
    ? Duration.decode(config.acquireRetryInterval)
    : DEFAULT_ACQUIRE_RETRY_INTERVAL;
  const backingFailureRetryPolicy = config.backingFailureRetryPolicy
    ? config.backingFailureRetryPolicy
    : DEFAULT_FAILURE_RETRY_POLICY;

  return {
    ttl,
    refreshInterval,
    acquireRetryInterval,
    backingFailureRetryPolicy,
  };
}

/**
 * Create a distributed mutex for the given key.
 */
export const make = (
  key: string,
  config: DistributedMutexConfig = {}
): Effect.Effect<DistributedMutex, never, DistributedLockBacking> =>
  Effect.gen(function* () {
    const backing = yield* DistributedLockBacking;

    // Generate unique holder ID for this instance
    const holderId = crypto.randomUUID();

    // Resolve config with defaults
    const {
      ttl,
      refreshInterval,
      acquireRetryInterval,
      backingFailureRetryPolicy,
    } = fullyResolveConfig(config);

    const withLockBackingErrorRetry = <A, E extends { _tag: string }, R>(
      effect: Effect.Effect<A, E | LockBackingError, R>
    ) =>
      effect.pipe(
        Effect.retry({
          while: (e) => e._tag === "LockBackingError",
          schedule: backingFailureRetryPolicy,
        })
      );

    // Keep the lock alive by refreshing TTL periodically.
    // This effect runs forever until interrupted (when scope closes).
    const keepAlive = Effect.repeat(
      Effect.gen(function* () {
        const refreshed = yield* backing
          .refresh(key, holderId, ttl)
          .pipe(withLockBackingErrorRetry);

        if (!refreshed) {
          return yield* new LockLostError({ key });
        }
      }),
      Schedule.spaced(refreshInterval)
    ).pipe(Effect.asVoid);

    // Try to acquire immediately, returns Option
    const tryAcquire: Effect.Effect<
      Option.Option<Fiber.Fiber<void, LockLostError | LockBackingError>>,
      LockBackingError,
      Scope.Scope
    > = Effect.gen(function* () {
      const acquired = yield* backing
        .tryAcquire(key, holderId, ttl)
        .pipe(withLockBackingErrorRetry);
      if (!acquired) {
        return Option.none();
      }

      // Start keepalive fiber, tied to this scope
      const keepAliveFiber = yield* Effect.forkScoped(keepAlive);

      // Add finalizer to release lock when scope closes
      yield* Effect.addFinalizer(() =>
        backing
          .release(key, holderId)
          .pipe(withLockBackingErrorRetry, Effect.ignore)
      );

      return Option.some(keepAliveFiber);
    });

    // Acquire with retry/timeout, returns void when acquired
    const acquire: Effect.Effect<
      Fiber.Fiber<void, LockLostError | LockBackingError>,
      LockBackingError,
      Scope.Scope
    > =
      // Retry until we acquire the lock
      Effect.gen(function* () {
        const maybeAcquired = yield* tryAcquire;
        if (Option.isNone(maybeAcquired)) {
          return yield* new NotYetAcquiredError();
        }
        return maybeAcquired.value;
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "NotYetAcquiredError",
          schedule: Schedule.spaced(acquireRetryInterval),
        }),
        Effect.catchTag("NotYetAcquiredError", () =>
          Effect.dieMessage(
            "Invariant violated: `acquire` should never return `NotYetAcquiredError " +
              "since it should be caught by the retry which should retry forever until the lock is acquired"
          )
        )
      );

    // Convenience: acquire lock, run effect, release when done
    const withLock = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | LockLostError | LockBackingError, R> =>
      Effect.scoped(
        Effect.gen(function* () {
          const keepAliveFiber = yield* acquire;
          const taskFiber = yield* Effect.fork(effect);
          return yield* Fiber.join(Fiber.zipLeft(taskFiber, keepAliveFiber));
        })
      );

    // Convenience: try to acquire, run effect if successful
    const withLockIfAvailable = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<
      Option.Option<A>,
      E | LockLostError | LockBackingError,
      R
    > =>
      Effect.scoped(
        Effect.gen(function* () {
          const maybeAcquired = yield* tryAcquire;
          if (Option.isNone(maybeAcquired)) {
            return Option.none();
          }
          const keepAliveFiber = maybeAcquired.value;
          const taskFiber = yield* Effect.fork(effect.pipe(Effect.asSome));
          return yield* Fiber.join(Fiber.zipLeft(taskFiber, keepAliveFiber));
        })
      );

    const isLocked: Effect.Effect<boolean, LockBackingError> = backing
      .isLocked(key)
      .pipe(withLockBackingErrorRetry);

    return {
      key,
      withLock,
      withLockIfAvailable,
      acquire,
      tryAcquire,
      isLocked,
    } satisfies DistributedMutex;
  });
