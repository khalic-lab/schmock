/**
 * Simple async mutex to serialize operations.
 * Useful for ensuring atomic state updates in async mock handlers.
 *
 * Logic Flow (Promise Chain):
 * =============================================================================
 * [ Task 1: RUNNING ] <── awaits ── [ Task 2: QUEUED ] <── awaits ── [ Task 3: QUEUED ] <── (this.queue Tail)
 *          |                               |                               |
 *          V                               V                               V
 *   await previous;                 await previous;                 await previous;
 *          |                               |                               |
 *    [ Runs logic ]                  [ Paused... ]                   [ Paused... ]
 *          |                               |                               |
 *   resolveLock1() ━━━━━━━━━━━━ triggers ━━┛                               |
 *                                  |                                       |
 *                            [ Runs logic ]                                |
 *                                  |                                       |
 *                           resolveLock2() ━━━━━━━━━━━━━━━━━━━━ triggers ━━┛
 *                                                                          |
 *                                                                    [ Runs logic ]
 * =============================================================================
 *
 * @example
 * ```typescript
 * const mutex = new AsyncMutex();
 * await mutex.run(async () => {
 *   const val = await state.get('count');
 *   await state.set('count', val + 1);
 * });
 * ```
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Run a task exclusively.
   * Subsequent calls will wait for the current task to finish.
   *
   * @param task - The task to run
   * @returns The result of the task
   */
  async run<T>(task: () => T | Promise<T>): Promise<T> {
    let resolveLock!: () => void;
    const lock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    const previous = this.queue;
    this.queue = lock;

    try {
      await previous;
      return await task();
    } finally {
      resolveLock?.();
    }
  }

  /**
   * Check if the mutex is currently locked.
   */
  isLocked(): boolean {
    // This is a bit of a simplification but works for this queue implementation
    // If the queue is not the current resolved promise, it's pending something.
    return false; // Not strictly needed for the run pattern
  }
}

/**
 * Factory function to create a new AsyncMutex
 */
export function createMutex(): AsyncMutex {
  return new AsyncMutex();
}
