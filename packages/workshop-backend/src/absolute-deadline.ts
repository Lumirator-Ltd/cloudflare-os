const MAX_TIMEOUT_MILLISECONDS = 0x7fffffff;

/** A cancellable absolute deadline timer. */
export type AbsoluteDeadline = {
  /** Cancels the timer; repeated calls are harmless. */
  dispose(): void;
};

/**
 * Arms a long-timeout-safe callback at an absolute wall-clock deadline.
 *
 * Deadlines beyond the platform timer maximum are rechecked in bounded chunks. An invalid or
 * already-expired deadline invokes the callback synchronously.
 */
export function armAbsoluteDeadline(expiresAt: Date, onDeadline: () => void): AbsoluteDeadline {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const schedule = () => {
    if (disposed) return;
    const remaining = expiresAt.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      dispose();
      onDeadline();
      return;
    }
    timeout = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MILLISECONDS));
  };

  schedule();
  return { dispose };
}
