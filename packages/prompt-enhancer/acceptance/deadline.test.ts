/**
 * Unit tests for the acceptance runner's wall-clock bound.
 *
 * The regression these lock down: a call that stalls somewhere the old timeout
 * did not cover (before the spawn, or after it while awaiting a `close` that
 * never arrives) hung the whole run. The property under test is that
 * `withDeadline` settles on the clock no matter what the work does — including
 * work that never settles and work that ignores its abort signal.
 */

import { describe, expect, it } from "vitest";
import { withDeadline } from "./deadline.js";

const never = new Promise<never>(() => {
  // Deliberately never settles: this is the hang being bounded.
});

describe("withDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    const result = await withDeadline(1_000, async () => "done");
    expect(result).toEqual({ ok: true, value: "done" });
  });

  it("leaves the signal unaborted on success", async () => {
    let seen: AbortSignal | undefined;
    await withDeadline(1_000, async (signal) => {
      seen = signal;
      return 1;
    });
    expect(seen?.aborted).toBe(false);
  });

  it("settles on the clock when the work never settles", async () => {
    const started = Date.now();
    const result = await withDeadline(20, () => never);
    expect(result).toEqual({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts the signal it handed to the work when the deadline expires", async () => {
    let seen: AbortSignal | undefined;
    const result = await withDeadline(20, (signal) => {
      seen = signal;
      return never;
    });
    expect(result.ok).toBe(false);
    expect(seen?.aborted).toBe(true);
  });

  it("does not wait for work that ignores the abort signal", async () => {
    let released = false;
    const result = await withDeadline(20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      released = true;
      return "late";
    });
    expect(result).toEqual({ ok: false, timedOut: true });
    expect(released).toBe(false);
  });

  it("propagates a rejection that beats the deadline", async () => {
    await expect(
      withDeadline(1_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("propagates a synchronous throw from the work factory", async () => {
    await expect(
      withDeadline(1_000, () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
  });

  it("swallows a failure that lands after the deadline", async () => {
    const result = await withDeadline(20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("too late");
    });
    expect(result).toEqual({ ok: false, timedOut: true });
    // Give the late rejection a turn to become an unhandled rejection if the
    // handler were missing; vitest fails the run when one escapes.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});
