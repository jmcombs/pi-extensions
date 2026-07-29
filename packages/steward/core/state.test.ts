import { describe, expect, it } from "vitest";
import type { UiState } from "./state.js";
import { initialUiState, LOG_BUFFER_LIMIT, reduce, visibleBuffer } from "./state.js";
import type { LogLine } from "./types.js";

function line(seq: number, message = `line ${seq}`): LogLine {
  return { seq, ts: 1_700_000_000_000 + seq, level: "INFO", modelId: null, message };
}

/** The same sequence number, from a source that started over. */
function restarted(seq: number): LogLine {
  return { ...line(seq, `restarted line ${seq}`), ts: 1_800_000_000_000 + seq };
}

function withLog(count: number): UiState {
  return reduce(initialUiState("light"), {
    type: "logs/append",
    lines: Array.from({ length: count }, (_, i) => line(i)),
  });
}

describe("logs/append", () => {
  it("appends in order", () => {
    const state = withLog(3);
    expect(state.log.map((l) => l.seq)).toEqual([0, 1, 2]);
  });

  it("drops lines the buffer already holds, so a stream reconnect is idempotent", () => {
    const state = withLog(3);
    const replayed = reduce(state, {
      type: "logs/append",
      lines: [line(1), line(2), line(3), line(4)],
    });
    expect(replayed.log.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns the same state when every incoming line is already held", () => {
    const state = withLog(3);
    expect(reduce(state, { type: "logs/append", lines: [line(0), line(2)] })).toBe(state);
    expect(reduce(state, { type: "logs/append", lines: [] })).toBe(state);
  });

  it("adopts the backlog whole when the source restarts its numbering", () => {
    const state = withLog(20);
    // A restarted source writes its own lines under numbers the buffer already
    // holds; that disagreement is what tells a restart from a replay.
    const fresh = [restarted(0), restarted(1)];
    const next = reduce(state, { type: "logs/append", lines: fresh });
    expect(next.log).toEqual(fresh);
  });

  it("adopts a batch that ends below everything the buffer holds", () => {
    // The buffer aged out the low numbers, so a batch below its window cannot
    // be a replay of anything it is showing.
    const state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: 5 }, (_, i) => line(300 + i)),
    });
    const next = reduce(state, { type: "logs/append", lines: [line(1), line(2)] });
    expect(next.log.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("ignores a partial replay of lines it already holds", () => {
    // The stream replays its backlog on reconnect and the browser coalesces
    // stream events per frame, so part of that replay can arrive on its own.
    const state = withLog(500);
    const replay = Array.from({ length: 80 }, (_, i) => line(300 + i));
    const next = reduce(state, { type: "logs/append", lines: replay });

    expect(next).toBe(state);
    expect(next.log).toHaveLength(500);
    expect(next.log[0]?.seq).toBe(0);
    expect(next.log.at(-1)?.seq).toBe(499);
  });

  it("keeps the new lines out of a batch that straddles the buffer's end", () => {
    const state = withLog(500);
    const straddle = [line(497), line(498), line(499), line(500), line(501)];
    const next = reduce(state, { type: "logs/append", lines: straddle });

    expect(next.log).toHaveLength(500);
    expect(next.log.at(-1)?.seq).toBe(501);
    expect(next.log.map((l) => l.seq).filter((seq) => seq === 499)).toHaveLength(1);
  });

  it("caps the ring buffer, keeping the newest lines", () => {
    const state = withLog(LOG_BUFFER_LIMIT + 40);
    expect(state.log).toHaveLength(LOG_BUFFER_LIMIT);
    expect(state.log[0]?.seq).toBe(40);
    expect(state.log.at(-1)?.seq).toBe(LOG_BUFFER_LIMIT + 39);
  });
});

describe("pause", () => {
  it("freezes the visible buffer while the live one keeps filling", () => {
    const live = withLog(3);
    const paused = reduce(live, { type: "logs/pause-toggle" });
    expect(paused.paused).toBe(true);

    const later = reduce(paused, { type: "logs/append", lines: [line(3), line(4)] });
    expect(later.log.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(visibleBuffer(later).map((l) => l.seq)).toEqual([0, 1, 2]);
  });

  it("returns to live on resume and discards the snapshot", () => {
    const paused = reduce(withLog(2), { type: "logs/pause-toggle" });
    const later = reduce(paused, { type: "logs/append", lines: [line(2)] });
    const resumed = reduce(later, { type: "logs/pause-toggle" });
    expect(resumed.paused).toBe(false);
    expect(resumed.frozen).toBeNull();
    expect(visibleBuffer(resumed).map((l) => l.seq)).toEqual([0, 1, 2]);
  });
});

describe("filters", () => {
  it("toggles a model filter off when the same card is clicked twice", () => {
    const one = reduce(initialUiState("light"), { type: "filter/model-toggle", modelId: "a" });
    expect(one.filterModel).toBe("a");
    const two = reduce(one, { type: "filter/model-toggle", modelId: "b" });
    expect(two.filterModel).toBe("b");
    expect(reduce(two, { type: "filter/model-toggle", modelId: "b" }).filterModel).toBeNull();
  });

  it("clears the model filter outright for the all-logs pill", () => {
    const one = reduce(initialUiState("light"), { type: "filter/model-toggle", modelId: "a" });
    expect(reduce(one, { type: "filter/model", modelId: null }).filterModel).toBeNull();
  });

  it("is single-select across levels", () => {
    const warn = reduce(initialUiState("light"), { type: "filter/level", level: "WARN" });
    expect(warn.filterLevel).toBe("WARN");
    expect(reduce(warn, { type: "filter/level", level: "all" }).filterLevel).toBe("all");
  });

  it("no-ops when a filter is re-applied", () => {
    const warn = reduce(initialUiState("light"), { type: "filter/level", level: "WARN" });
    expect(reduce(warn, { type: "filter/level", level: "WARN" })).toBe(warn);
    const q = reduce(warn, { type: "filter/query", query: "slot" });
    expect(reduce(q, { type: "filter/query", query: "slot" })).toBe(q);
  });
});

describe("pending actions", () => {
  it("tracks one service action at a time", () => {
    const s = reduce(initialUiState("light"), { type: "service/pending", action: "restart" });
    expect(s.pendingService).toBe("restart");
    expect(reduce(s, { type: "service/pending", action: null }).pendingService).toBeNull();
  });

  it("holds one open confirm, and returns the same state for a no-op", () => {
    const open = reduce(initialUiState("light"), { type: "service/confirm", action: "stop" });
    expect(open.confirmService).toBe("stop");
    expect(reduce(open, { type: "service/confirm", action: "stop" })).toBe(open);
    expect(reduce(open, { type: "service/confirm", action: null }).confirmService).toBeNull();
  });

  it("remembers the last service failure until it is cleared", () => {
    const failure = { action: "restart" as const, detail: "launchctl: permission denied" };
    const failed = reduce(initialUiState("light"), { type: "service/failure", failure });
    expect(failed.serviceFailure).toEqual(failure);
    // Clearing an already-clear notice changes nothing, so no repaint follows.
    const cleared = reduce(failed, { type: "service/failure", failure: null });
    expect(cleared.serviceFailure).toBeNull();
    expect(reduce(cleared, { type: "service/failure", failure: null })).toBe(cleared);
  });

  it("tracks model actions per model and clears them independently", () => {
    let s = reduce(initialUiState("light"), {
      type: "model/pending",
      modelId: "a",
      action: "unload",
    });
    s = reduce(s, { type: "model/pending", modelId: "b", action: "load" });
    expect(s.pendingModels).toEqual({ a: "unload", b: "load" });

    s = reduce(s, { type: "model/pending", modelId: "a", action: null });
    expect(s.pendingModels).toEqual({ b: "load" });
  });

  it("no-ops when clearing a model that was not pending", () => {
    const s = initialUiState("light");
    expect(reduce(s, { type: "model/pending", modelId: "a", action: null })).toBe(s);
  });
});

describe("pending lifecycle (models/observed)", () => {
  function pending(a: "load" | "unload", id = "a"): UiState {
    return reduce(initialUiState("light"), { type: "model/pending", modelId: id, action: a });
  }

  it("keeps a load pending while the model is still loading", () => {
    const s = pending("load");
    const next = reduce(s, { type: "models/observed", models: [{ id: "a", status: "loading" }] });
    expect(next.pendingModels).toEqual({ a: "load" });
    // A no-op reconcile returns the same object, so the poll can skip a repaint.
    expect(next).toBe(s);
  });

  it("clears a load once the model reaches active or resident", () => {
    expect(
      reduce(pending("load"), {
        type: "models/observed",
        models: [{ id: "a", status: "resident" }],
      }).pendingModels,
    ).toEqual({});
    expect(
      reduce(pending("load"), { type: "models/observed", models: [{ id: "a", status: "active" }] })
        .pendingModels,
    ).toEqual({});
  });

  it("clears a load that the router accepted but then failed back to unloaded", () => {
    // Otherwise the button would spin "Loading…" forever; the model reverting to
    // unloaded is the only signal that a POST-accepted load did not complete.
    expect(
      reduce(pending("load"), {
        type: "models/observed",
        models: [{ id: "a", status: "unloaded" }],
      }).pendingModels,
    ).toEqual({});
  });

  it("clears an unload once the model is unloaded or gone from the list", () => {
    expect(
      reduce(pending("unload"), {
        type: "models/observed",
        models: [{ id: "a", status: "unloaded" }],
      }).pendingModels,
    ).toEqual({});
    // A model that vanishes from /models is unloaded for our purposes.
    expect(
      reduce(pending("unload"), { type: "models/observed", models: [] }).pendingModels,
    ).toEqual({});
  });

  it("does not clear an unload while the model is still resident", () => {
    const s = pending("unload");
    expect(reduce(s, { type: "models/observed", models: [{ id: "a", status: "resident" }] })).toBe(
      s,
    );
  });

  it("reconciles each pending model independently", () => {
    let s = pending("load", "a");
    s = reduce(s, { type: "model/pending", modelId: "b", action: "unload" });
    const next = reduce(s, {
      type: "models/observed",
      models: [
        { id: "a", status: "active" },
        { id: "b", status: "resident" },
      ],
    });
    // a's load is done; b's unload is not.
    expect(next.pendingModels).toEqual({ b: "unload" });
  });
});

describe("theme and copy flag", () => {
  it("cycles the theme system → light → dark → system", () => {
    const light = reduce(initialUiState("system"), { type: "theme/toggle" });
    expect(light.theme).toBe("light");
    const dark = reduce(light, { type: "theme/toggle" });
    expect(dark.theme).toBe("dark");
    expect(reduce(dark, { type: "theme/toggle" }).theme).toBe("system");
  });

  it("raises and lowers the copied acknowledgement", () => {
    const copied = reduce(initialUiState("light"), { type: "copy/flag", copied: true });
    expect(copied.copied).toBe(true);
    expect(reduce(copied, { type: "copy/flag", copied: true })).toBe(copied);
    expect(reduce(copied, { type: "copy/flag", copied: false }).copied).toBe(false);
  });
});
