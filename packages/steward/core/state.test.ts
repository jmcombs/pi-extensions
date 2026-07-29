import { describe, expect, it } from "vitest";
import type { UiState } from "./state.js";
import {
  initialUiState,
  LOG_BUFFER_LIMIT,
  POLL_BUFFER_LIMIT,
  reduce,
  visibleBuffer,
} from "./state.js";
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

describe("drift dismissal", () => {
  it("remembers the key of the dismissed notice", () => {
    const dismissed = reduce(initialUiState("light"), { type: "drift/dismiss", key: "launch:-x" });
    expect(dismissed.dismissedDrift).toBe("launch:-x");
  });

  it("starts with nothing dismissed, so a reload shows the mismatch again", () => {
    // The dismissal is session state on purpose: a mismatch that is still there
    // must never be hidden by a click from a previous page load.
    expect(initialUiState("light").dismissedDrift).toBeNull();
  });

  it("is a no-op when the same notice is dismissed twice", () => {
    const dismissed = reduce(initialUiState("light"), { type: "drift/dismiss", key: "k" });
    expect(reduce(dismissed, { type: "drift/dismiss", key: "k" })).toBe(dismissed);
  });

  it("can be cleared", () => {
    const dismissed = reduce(initialUiState("light"), { type: "drift/dismiss", key: "k" });
    expect(reduce(dismissed, { type: "drift/dismiss", key: null }).dismissedDrift).toBeNull();
  });
});

describe("the class-aware buffer cap", () => {
  function proxy(seq: number): LogLine {
    return { ...line(seq, `proxy ${seq}`), kind: "proxy" };
  }

  it("spends a separate budget on signal and on poll traffic", () => {
    // 400 proxy lines then 20 signal lines: under one shared budget the signal
    // would still be there, but on a real router the ratio is 87:13 and the
    // banner the operator wants is what gets evicted.
    const lines = [
      ...Array.from({ length: 400 }, (_, i) => proxy(i)),
      ...Array.from({ length: 20 }, (_, i) => line(400 + i)),
    ];
    const state = reduce(initialUiState("light"), { type: "logs/append", lines });
    const kinds = state.log.map((entry) => entry.kind ?? "event");
    expect(kinds.filter((kind) => kind === "proxy")).toHaveLength(POLL_BUFFER_LIMIT);
    expect(kinds.filter((kind) => kind !== "proxy")).toHaveLength(20);
  });

  it("keeps the newest of each class and stays ascending by seq", () => {
    const lines = Array.from({ length: POLL_BUFFER_LIMIT + 50 }, (_, i) => proxy(i));
    const state = reduce(initialUiState("light"), { type: "logs/append", lines });
    expect(state.log[0]?.seq).toBe(50);
    expect(state.log.at(-1)?.seq).toBe(POLL_BUFFER_LIMIT + 49);
    const seqs = state.log.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("caps signal lines at the signal budget", () => {
    const lines = Array.from({ length: LOG_BUFFER_LIMIT + 30 }, (_, i) => line(i));
    const state = reduce(initialUiState("light"), { type: "logs/append", lines });
    expect(state.log).toHaveLength(LOG_BUFFER_LIMIT);
    expect(state.log[0]?.seq).toBe(30);
  });

  it("flags a dropped SIGNAL line and never a dropped proxy line", () => {
    const proxied = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: POLL_BUFFER_LIMIT + 10 }, (_, i) => proxy(i)),
    });
    // A proxy eviction is the recency window working as designed; saying so
    // would put a permanent banner on every live router.
    expect(proxied.bufferDropped).toBe(false);

    const signal = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: LOG_BUFFER_LIMIT + 1 }, (_, i) => line(i)),
    });
    expect(signal.bufferDropped).toBe(true);
  });

  it("keeps the flag raised once lines have been lost", () => {
    let state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: LOG_BUFFER_LIMIT + 1 }, (_, i) => line(i)),
    });
    state = reduce(state, { type: "logs/append", lines: [line(LOG_BUFFER_LIMIT + 1)] });
    expect(state.bufferDropped).toBe(true);
  });

  it("leaves the restart-detection path intact", () => {
    const state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: [line(0), line(1), line(2)],
    });
    const restarts = reduce(state, {
      type: "logs/append",
      lines: [restarted(0), restarted(1)],
    });
    expect(restarts.log.map((entry) => entry.message)).toEqual([
      "restarted line 0",
      "restarted line 1",
    ]);
  });
});

describe("the proxied-request toggle", () => {
  it("starts hidden and flips", () => {
    const state = initialUiState("light");
    expect(state.showProxy).toBe(false);
    const shown = reduce(state, { type: "filter/proxy-toggle" });
    expect(shown.showProxy).toBe(true);
    expect(reduce(shown, { type: "filter/proxy-toggle" }).showProxy).toBe(false);
  });
});

describe("args folds", () => {
  it("opens and closes one run, keyed by its first seq", () => {
    const open = reduce(initialUiState("light"), { type: "logs/fold-toggle", seq: 12 });
    expect(open.expandedArgs).toEqual({ 12: true });
    expect(reduce(open, { type: "logs/fold-toggle", seq: 12 }).expandedArgs).toEqual({});
  });

  it("keeps runs independent", () => {
    let state = reduce(initialUiState("light"), { type: "logs/fold-toggle", seq: 12 });
    state = reduce(state, { type: "logs/fold-toggle", seq: 40 });
    expect(state.expandedArgs).toEqual({ 12: true, 40: true });
  });
});

describe("log stream and source health", () => {
  it("starts connecting against a source it has not been told about", () => {
    const state = initialUiState("light");
    expect(state.logStream).toBe("connecting");
    // `ok` until told otherwise: a console that has not heard yet must not
    // accuse the server of anything.
    expect(state.logSource).toBe("ok");
    expect(state.logSourcePath).toBeNull();
    expect(state.logSourceDetail).toBeNull();
  });

  it("records the stream state and no-ops on a repeat", () => {
    const live = reduce(initialUiState("light"), { type: "logs/stream-status", status: "live" });
    expect(live.logStream).toBe("live");
    expect(reduce(live, { type: "logs/stream-status", status: "live" })).toBe(live);
  });

  it("records the source state with the path it names", () => {
    const missing = reduce(initialUiState("light"), {
      type: "logs/source-status",
      source: "missing",
      path: "/tmp/llama-router.log",
      detail: "/tmp/llama-router.log does not exist",
    });
    expect(missing.logSource).toBe("missing");
    expect(missing.logSourcePath).toBe("/tmp/llama-router.log");
    // The server's own words are kept: they are what tells an operator whether
    // to fix a permission or wait for the file to come back.
    expect(missing.logSourceDetail).toBe("/tmp/llama-router.log does not exist");
    expect(
      reduce(missing, {
        type: "logs/source-status",
        source: "missing",
        path: "/tmp/llama-router.log",
        detail: "/tmp/llama-router.log does not exist",
      }),
    ).toBe(missing);
  });
});

describe("bufferDropped across a source restart", () => {
  it("clears the flag when the buffer is replaced wholesale", () => {
    // A restart replaces the buffer, so nothing on screen is older than it.
    // Carrying the flag over would leave a permanent "older lines dropped"
    // banner on a console holding every line the new source ever wrote.
    let state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: LOG_BUFFER_LIMIT + 120 }, (_, i) => line(i + 1)),
    });
    expect(state.bufferDropped).toBe(true);

    state = reduce(state, {
      type: "logs/append",
      lines: Array.from({ length: 11 }, (_, i) => restarted(i + 1)),
    });
    expect(state.log).toHaveLength(11);
    expect(state.log.map((entry) => entry.message)).toEqual(
      Array.from({ length: 11 }, (_, i) => `restarted line ${i + 1}`),
    );
    expect(state.bufferDropped).toBe(false);
  });

  it("raises it again if the NEW source overruns the buffer", () => {
    let state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: [line(1), line(2), line(3)],
    });
    state = reduce(state, {
      type: "logs/append",
      lines: Array.from({ length: LOG_BUFFER_LIMIT + 5 }, (_, i) => restarted(i + 1)),
    });
    expect(state.bufferDropped).toBe(true);
  });

  it("keeps the flag across an ordinary append that drops nothing", () => {
    let state = reduce(initialUiState("light"), {
      type: "logs/append",
      lines: Array.from({ length: LOG_BUFFER_LIMIT + 1 }, (_, i) => line(i + 1)),
    });
    state = reduce(state, { type: "logs/append", lines: [line(LOG_BUFFER_LIMIT + 2)] });
    expect(state.bufferDropped).toBe(true);
  });
});

describe("restart detection after the frame moved out of the message", () => {
  /**
   * A `print_timing` line as the parser now produces it: the whole `id N |
   * task N | ` frame in its own field, the payload in `message`. Two different
   * requests' `eval time` lines are byte-identical in every field EXCEPT the
   * task id — which is precisely why the id has to be part of the comparison.
   */
  function timing(seq: number, task: number): LogLine {
    return {
      seq,
      ts: 1_700_000_000_000 + seq,
      level: "INFO",
      modelId: "gpt-oss-20b",
      port: 62354,
      frame: {
        slot: 0,
        task,
        raw: `slot print_timing: id  0 | task ${task} | `,
      },
      message: "       eval time =   873.11 ms /   120 tokens",
    };
  }

  it("adopts a restarted source whose lines differ only by task id", () => {
    // The bug this pins: with the frame relocated, `sameLine` compared two
    // different tasks' timing lines as EQUAL. `appendLines` reads it to tell a
    // stream replay from a source that restarted its numbering, so a restarted
    // server's whole backlog would be mistaken for a replay and discarded —
    // and the console would sit there holding the dead source's lines forever.
    const held = [timing(1, 81259), timing(2, 81259)];
    const state = reduce(initialUiState("light"), { type: "logs/append", lines: held });

    const fresh = [timing(1, 90001), timing(2, 90002)];
    const next = reduce(state, { type: "logs/append", lines: fresh });
    expect(next.log).toEqual(fresh);
  });

  it("still treats a genuine replay of the same lines as a replay", () => {
    const held = [timing(1, 81259), timing(2, 81260)];
    const state = reduce(initialUiState("light"), { type: "logs/append", lines: held });
    expect(reduce(state, { type: "logs/append", lines: held })).toBe(state);
  });
});

describe("the trace", () => {
  const TRACE = { port: 62354, task: 81259, anchorSeq: 12 };

  it("opens and closes, and no-ops on the same reference", () => {
    const open = reduce(initialUiState("light"), { type: "logs/trace", trace: TRACE });
    expect(open.trace).toEqual(TRACE);
    expect(reduce(open, { type: "logs/trace", trace: { ...TRACE } })).toBe(open);
    expect(reduce(open, { type: "logs/trace", trace: null }).trace).toBeNull();
  });

  it("is closed by EVERY filter action, in the reducer", () => {
    // In the reducer and not in a handler, so a control added later cannot
    // forget it — which is what lets the toolbar leave everything enabled while
    // a trace is open.
    const actions = [
      { type: "filter/model", modelId: "gpt-oss-20b" },
      { type: "filter/model-toggle", modelId: "gpt-oss-20b" },
      { type: "filter/level", level: "WARN" },
      { type: "filter/family", family: "models" },
      { type: "filter/query", query: "eval" },
      { type: "filter/proxy-toggle" },
    ] as const;
    for (const action of actions) {
      const open = reduce(initialUiState("light"), { type: "logs/trace", trace: TRACE });
      expect(reduce(open, action).trace, action.type).toBeNull();
    }
  });

  it("is closed even by a filter action that changes nothing else", () => {
    // Pressing the chip that is already pressed still means "leave the trace".
    let state = reduce(initialUiState("light"), { type: "filter/level", level: "WARN" });
    state = reduce(state, { type: "logs/trace", trace: TRACE });
    const next = reduce(state, { type: "filter/level", level: "WARN" });
    expect(next.trace).toBeNull();
    expect(next.filterLevel).toBe("WARN");
  });

  it("survives everything that is not a filter", () => {
    let state = reduce(initialUiState("light"), { type: "logs/trace", trace: TRACE });
    state = reduce(state, { type: "logs/append", lines: [line(1)] });
    state = reduce(state, { type: "logs/pause-toggle" });
    state = reduce(state, { type: "theme/toggle" });
    expect(state.trace).toEqual(TRACE);
  });
});
