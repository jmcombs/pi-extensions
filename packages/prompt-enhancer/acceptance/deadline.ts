/**
 * Wall-clock bounding for the acceptance runner.
 *
 * **Test scaffolding, not shipped code** (excluded from `package.json` `files`).
 *
 * Why this exists. The runner's first timeout lived *inside* the child-process
 * promise, so it covered only the window between the spawn and the completion
 * rule. Two phases of a call were bounded by nothing:
 *
 *   - everything before the spawn (context gathering, which shells out to git);
 *   - everything after the completion rule fired, because `finish()` cleared
 *     the timer and then waited on a child `close` event that is not guaranteed
 *     to arrive.
 *
 * Measured on 2026-08-20: a 72-call run sat **14 min 40 s** using 1.6 s of CPU
 * with no `pi` child process alive, while `DEFAULT_TIMEOUT_MS = 120_000` never
 * fired once.
 *
 * `withDeadline` fixes the shape rather than one stall. It settles when the
 * clock says so, whatever the work is doing and wherever it is blocked, so no
 * phase of a call can outlive its budget. Work that ignores the abort signal is
 * abandoned, not awaited.
 */

export type DeadlineResult<T> = { ok: true; value: T } | { ok: false; timedOut: true };

/**
 * Run `work` with a hard wall-clock bound.
 *
 * Resolves `{ ok: true, value }` if `work` settles first, or
 * `{ ok: false, timedOut: true }` the moment `timeoutMs` elapses — without
 * waiting for `work`, which is signalled through the `AbortSignal` it was given
 * and then left to unwind on its own. A rejection from `work` propagates only
 * while the deadline is still pending; afterwards it is swallowed, so a late
 * failure can never surface as an unhandled rejection.
 */
export function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  return new Promise<DeadlineResult<T>>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(new Error(`deadline exceeded after ${String(timeoutMs)} ms`));
      resolve({ ok: false, timedOut: true });
    }, timeoutMs);

    let started: Promise<T>;
    try {
      started = work(controller.signal);
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    started.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        // A rejection after the deadline is deliberately dropped: the caller
        // already has its verdict, and rethrowing would be an unhandled
        // rejection with no listener left.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
