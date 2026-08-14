import { afterEach, describe, expect, it, vi } from "vitest";
import { armAbsoluteDeadline } from "../src/absolute-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("armAbsoluteDeadline", () => {
  it("reschedules deadlines longer than the platform timeout maximum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const platformMaximum = 0x7fffffff;
    const onDeadline = vi.fn();
    armAbsoluteDeadline(new Date(Date.now() + platformMaximum + 1_000), onDeadline);

    await vi.advanceTimersByTimeAsync(platformMaximum);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("fires immediately for an expired deadline and can be disposed", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    armAbsoluteDeadline(new Date(Date.now() - 1), expired);
    expect(expired).toHaveBeenCalledOnce();

    const future = vi.fn();
    const deadline = armAbsoluteDeadline(new Date(Date.now() + 1_000), future);
    deadline.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(future).not.toHaveBeenCalled();
  });
});
