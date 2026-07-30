/**
 * The slot tracker's contract is: occupancy is what the log said, uncertainty is
 * reported as uncertainty, and nothing is ever held past the moment it stopped
 * being true.
 *
 * Every line these tests feed it is a verbatim line from a real 121,500-line
 * `llama-router.log`, pushed through the real {@link parseLogLine} rather than
 * hand-assembled — so the padded `slot      release:` head, the `[port]` prefix,
 * the elapsed stamp and the pipe frame are all exercised as the file actually
 * writes them. A tracker that passes against invented lines and fails against
 * these would be worse than no tracker at all.
 */

import { describe, expect, it } from "vitest";
import { parseLogLine } from "./log-parse.js";
import { createSlotActivity, MAX_SEED_ATTEMPTS, SLOT_STALE_MS } from "./slot-activity.js";
import type { LogLine } from "./types.js";

const PORT = 53093;
const T0 = 1_760_000_000_000;

let nextSeq = 0;

/** One real log line, parsed and stamped the way the tailer stamps it. */
function line(raw: string, at: number = T0): LogLine {
  const parsed = parseLogLine(raw);
  nextSeq += 1;
  return {
    seq: nextSeq,
    ts: at,
    level: parsed.level,
    modelId: parsed.modelName,
    message: parsed.message,
    kind: parsed.kind,
    origin: parsed.origin,
    family: parsed.family,
    ...(parsed.port === null ? {} : { port: parsed.port }),
    ...(parsed.frame === null ? {} : { frame: parsed.frame }),
  };
}

/* Verbatim shapes from the captured corpus. */
const SELECT =
  "[53093] 736.46.933.316 I slot get_availabl: id  0 | task -1 | selected slot by LCP similarity, sim_best = 0.865 (> 0.100 thold), f_keep = 0.388";
const LAUNCH =
  "[53093] 736.46.935.806 I slot launch_slot_: id  0 | task 836989 | processing task, is_child = 0";
const CHECKPOINT =
  "[53093] 736.46.941.616 W slot create_check: id  0 | task 836989 | erasing old context checkpoint (pos_min = 0, pos_max = 60, n_tokens = 61, size = 0.761 MiB)";
const PROMPT_EVAL =
  "[53093] 736.47.702.198 I slot print_timing: id  0 | task 836989 | prompt eval time =      68.97 ms /    14 tokens (    4.93 ms per token,   202.99 tokens per second)";
const EVAL =
  "[53093] 736.47.702.201 I slot print_timing: id  0 | task 836989 |        eval time =     697.41 ms /    90 tokens (    7.75 ms per token,   129.05 tokens per second)";
const TOTAL =
  "[53093] 736.47.702.201 I slot print_timing: id  0 | task 836989 |       total time =     766.38 ms /   104 tokens";
const RELEASE =
  "[53093] 736.47.702.218 I slot      release: id  0 | task 836989 | stop processing: n_tokens = 163, truncated = 0";
const LIVE_RATE =
  "[53093] 714.27.584.589 I slot print_timing: id  0 | task 836989 | n_decoded =    663, tg = 110.43 t/s, tg_3s = 109.88 t/s";
const PREFILL =
  "[55866] 1.00.899.140 I slot print_timing: id  0 | task 988 | prompt processing, n_tokens =  16385, progress = 0.85, t =  13.94 s / 1175.06 tokens per second";
const LAUNCH_NEXT =
  "[53093] 736.51.731.799 I slot launch_slot_: id  0 | task 837088 | processing task, is_child = 0";
const LAUNCH_SLOT1 =
  "[53093] 736.51.731.799 I slot launch_slot_: id  1 | task 837099 | processing task, is_child = 0";
const PROXY =
  "736.46.930.000 I srv  proxy_reques: proxying request to model gpt-oss-20b on port 53093";
const BANNER =
  "0.25.748.157 I srv          load: spawning server instance with name=gpt-oss-20b on port 53093";

describe("createSlotActivity — occupancy from events", () => {
  it("registers a request shorter than one poll interval, both edges", () => {
    // THE BUG. This whole request runs in 0.77 s against a 1.6 s poll clock, so
    // a sampled `/slots` read would have seen an idle slot before it and an idle
    // slot after it, and reported the server as doing nothing at all.
    const activity = createSlotActivity();
    activity.observe(line(SELECT));
    activity.observe(line(LAUNCH));

    // Mid-request: busy, and attributed to the task that is actually running.
    const open = activity.resolve(PORT, T0).get(0);
    expect(open?.state).toBe("processing");
    expect(open?.task).toBe(836989);

    activity.observe(line(CHECKPOINT));
    activity.observe(line(PROMPT_EVAL));
    activity.observe(line(EVAL));
    activity.observe(line(TOTAL));
    activity.observe(line(RELEASE));

    const done = activity.resolve(PORT, T0).get(0);
    expect(done?.state).toBe("idle");
    expect(done?.task).toBeNull();
  });

  it("takes the generation rate off the timing line and drops it at the release", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    // A launched request has no rate yet, and unmeasured is not zero.
    expect(activity.resolve(PORT, T0).get(0)?.rateTps).toBeNull();

    activity.observe(line(EVAL));
    const timed = activity.resolve(PORT, T0).get(0);
    expect(timed?.rateTps).toBeCloseTo(129.05, 2);
    expect(timed?.decoded).toBe(90);

    // Once the slot is released the rate is a fact about a request that is over.
    // Carrying it would be exactly the stale held number that made the polled
    // `/metrics` gauge misleading.
    activity.observe(line(RELEASE));
    expect(activity.resolve(PORT, T0).get(0)?.rateTps).toBeNull();
  });

  it("never mistakes the prefill timing line for a generation rate", () => {
    // `prompt eval time` and `eval time` differ by one word and mean completely
    // different things; only the second is tokens the model generated.
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    activity.observe(line(PROMPT_EVAL));
    expect(activity.resolve(PORT, T0).get(0)?.rateTps).toBeNull();
  });

  it("reads the live in-flight rate, and treats it as proof the slot is working", () => {
    const activity = createSlotActivity();
    // No launch was seen — the tracker starts knowing nothing about this slot —
    // and a running readout still establishes it.
    activity.observe(line(LIVE_RATE));
    const state = activity.resolve(PORT, T0).get(0);
    expect(state?.state).toBe("processing");
    expect(state?.decoded).toBe(663);
    expect(state?.rateTps).toBeCloseTo(109.88, 2);
  });

  it("takes the held context off a release, and a live prefill's progress", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    activity.observe(line(RELEASE));
    // `n_tokens` at the release is the context the slot is left holding, and it
    // stays true while the slot sits idle.
    expect(activity.resolve(PORT, T0).get(0)?.promptTokens).toBe(163);

    activity.observe(line(PREFILL));
    expect(activity.resolve(55866, T0).get(0)?.promptTokens).toBe(16385);
  });

  it("ignores every line that is not a slot event", () => {
    const activity = createSlotActivity();
    activity.observe(line(PROXY));
    activity.observe(line(BANNER));
    // A checkpoint line carries `n_tokens = 61` and must not be read as one.
    activity.observe(line(CHECKPOINT));
    expect(activity.resolve(PORT, T0).get(0)?.promptTokens ?? null).toBeNull();
  });
});

describe("createSlotActivity — re-sync", () => {
  it("resolves a missed release to unknown rather than leaving it stuck busy", () => {
    // The failure mode this exists to prevent: the release fell out of the
    // buffer, or the tailer re-anchored across it, and the lane would otherwise
    // read `busy` for the rest of the session.
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    expect(activity.resolve(PORT, T0).get(0)?.state).toBe("processing");

    // A genuinely long request keeps reporting, so the bound is generous and
    // still-running work is never flagged.
    expect(activity.resolve(PORT, T0 + SLOT_STALE_MS).get(0)?.state).toBe("processing");

    const stale = activity.resolve(PORT, T0 + SLOT_STALE_MS + 1).get(0);
    // Unknown, NOT idle: losing the release is evidence we lost track, never
    // evidence the request finished.
    expect(stale?.state).toBe("unknown");
    expect(stale?.task).toBeNull();
    expect(stale?.rateTps).toBeNull();
  });

  it("re-arms the staleness bound from a running request's own reporting", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH, T0));
    // llama.cpp prints a running readout roughly every 3 s, so a request still
    // going pushes its own deadline out.
    activity.observe(line(LIVE_RATE, T0 + SLOT_STALE_MS - 1));
    expect(activity.resolve(PORT, T0 + SLOT_STALE_MS + 1).get(0)?.state).toBe("processing");
  });

  it("resolves a missed release the moment the server reuses the slot", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    // The release for task 836989 never arrived; a launch for a different task
    // on the same lane says so unambiguously.
    activity.observe(line(LAUNCH_NEXT));
    const state = activity.resolve(PORT, T0).get(0);
    expect(state?.state).toBe("processing");
    expect(state?.task).toBe(837088);
  });

  it("treats slot selection as the exact idle observation it is", () => {
    // `get_available_slot` only ever names a slot it found FREE, and it runs
    // before a task is attached — hence `task -1`. So this line resolves a lane
    // we wrongly believed was busy, for free, on the very next request.
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    activity.observe(line(SELECT));
    const state = activity.resolve(PORT, T0).get(0);
    expect(state?.state).toBe("idle");
    expect(state?.task).toBeNull();
  });

  it("starts every slot unknown and keeps lanes independent", () => {
    const activity = createSlotActivity();
    expect(activity.resolve(PORT, T0).size).toBe(0);
    activity.observe(line(LAUNCH_SLOT1));
    // Lane 1 is working; lane 0 was never mentioned and stays unspoken for
    // rather than being assumed idle.
    expect(activity.resolve(PORT, T0).get(1)?.state).toBe("processing");
    expect(activity.resolve(PORT, T0).get(0)).toBeUndefined();
  });

  it("forgets a child that exited, so a reload starts clean", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    activity.retain([55866]);
    // Slot and task numbering belong to a process that no longer exists.
    expect(activity.resolve(PORT, T0).size).toBe(0);
    expect(activity.needsSeed(PORT, T0)).toBe(true);
  });

  it("drops everything on an explicit re-sync, and asks to be established again", () => {
    const activity = createSlotActivity();
    activity.observe(line(LAUNCH));
    activity.applySeed(PORT, activity.beginSeed(PORT, T0), [], T0);
    expect(activity.needsSeed(PORT, T0)).toBe(false);

    activity.resync();
    expect(activity.resolve(PORT, T0).size).toBe(0);
    expect(activity.needsSeed(PORT, T0)).toBe(true);
  });
});

describe("createSlotActivity — the one-shot seed", () => {
  it("asks once per child and then never again", () => {
    const activity = createSlotActivity();
    expect(activity.needsSeed(PORT, T0)).toBe(true);

    const stamp = activity.beginSeed(PORT, T0);
    activity.applySeed(
      PORT,
      stamp,
      [{ slot: 0, state: "idle", promptTokens: 12, decoded: null }],
      T0,
    );

    // Settled. Asking on every snapshot must not produce a read on every
    // snapshot — that is the polling loop this change removed.
    expect(activity.needsSeed(PORT, T0)).toBe(false);
    expect(activity.needsSeed(PORT, T0)).toBe(false);
    expect(activity.resolve(PORT, T0).get(0)?.state).toBe("idle");
  });

  it("gives up after a bounded number of failed reads", () => {
    const activity = createSlotActivity();
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt += 1) {
      expect(activity.needsSeed(PORT, T0)).toBe(true);
      activity.beginSeed(PORT, T0); // the read failed; no seed is applied
    }
    // A `/slots` that always errors cannot become an unbounded retry loop.
    expect(activity.needsSeed(PORT, T0)).toBe(false);
  });

  it("lets an event that landed mid-read win over the read", () => {
    const activity = createSlotActivity();
    const stamp = activity.beginSeed(PORT, T0);
    // The HTTP call is in flight; a launch arrives while it is.
    activity.observe(line(LAUNCH));
    activity.applySeed(
      PORT,
      stamp,
      [{ slot: 0, state: "idle", promptTokens: null, decoded: null }],
      T0,
    );
    // The four-second-old answer must not undo what just happened.
    expect(activity.resolve(PORT, T0).get(0)?.state).toBe("processing");
  });

  it("reopens for one more read when a lane goes stale, once", () => {
    const activity = createSlotActivity();
    activity.applySeed(
      PORT,
      activity.beginSeed(PORT, T0),
      [{ slot: 0, state: "processing", promptTokens: null, decoded: null }],
      T0,
    );
    expect(activity.needsSeed(PORT, T0)).toBe(false);

    const later = T0 + SLOT_STALE_MS + 1;
    // Losing track of a lane is new uncertainty and earns a fresh budget…
    expect(activity.needsSeed(PORT, later)).toBe(true);
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt += 1) {
      activity.beginSeed(PORT, later);
    }
    // …but only one budget: a lane that stays stale must not re-arm the retry
    // on every snapshot, which would rebuild the poll by accident.
    expect(activity.needsSeed(PORT, later)).toBe(false);
  });

  it("keeps asking about a lane the log never mentions, paced off the snapshot clock", () => {
    // The lane-starvation case. llama.cpp's LCP affinity sends every request to
    // lane 0, so lanes 1-3 of a `--parallel 4` model are never named by any
    // event — and they are not `processing`, so they never trip the stale edge
    // either. Without the declared lane count this port looks perfectly settled
    // and nothing would ever ask about them again.
    const activity = createSlotActivity();
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt += 1) {
      expect(activity.needsSeed(PORT, T0, 4)).toBe(true);
      activity.beginSeed(PORT, T0); // every read fails
    }
    activity.observe(line(LAUNCH)); // lane 0 establishes itself; 1-3 do not

    // The budget is spent, so it goes quiet rather than retrying on every tick.
    expect(activity.needsSeed(PORT, T0, 4)).toBe(false);
    expect(activity.needsSeed(PORT, T0 + 1_600, 4)).toBe(false);
    expect(activity.needsSeed(PORT, T0 + 60_000, 4)).toBe(false);

    // But it does come back — once the staleness bound has passed, not before.
    expect(activity.needsSeed(PORT, T0 + SLOT_STALE_MS, 4)).toBe(true);
  });

  it("stops asking once every declared lane is accounted for", () => {
    const activity = createSlotActivity();
    activity.applySeed(
      PORT,
      activity.beginSeed(PORT, T0),
      [
        { slot: 0, state: "idle", promptTokens: null, decoded: null },
        { slot: 1, state: "idle", promptTokens: null, decoded: null },
      ],
      T0,
    );
    // Both declared lanes are established and neither can go stale, so there is
    // nothing left to resolve and the retry must never fire — this is what keeps
    // it off the clock for the overwhelmingly common healthy case.
    expect(activity.needsSeed(PORT, T0 + SLOT_STALE_MS * 10, 2)).toBe(false);
  });

  it("re-arms a long-running lane so the seed can confirm it is still working", () => {
    // The mechanism D1 describes: `tg_3s` needs 100 decoded tokens as well as
    // 3 s, so a slow short generation reports nothing at all and crosses the
    // bound in silence. The seed — not the log — is what keeps it truthful.
    const activity = createSlotActivity();
    activity.applySeed(
      PORT,
      activity.beginSeed(PORT, T0),
      [{ slot: 0, state: "processing", promptTokens: null, decoded: null }],
      T0,
    );
    expect(activity.needsSeed(PORT, T0, 1)).toBe(false);
    expect(activity.needsSeed(PORT, T0 + SLOT_STALE_MS + 1, 1)).toBe(true);
  });

  it("re-arms for a lane the seed itself could not establish", () => {
    // `/slots` answered, but with a body carrying no `is_processing`, so the
    // lane is explicitly unknown rather than merely unmentioned.
    const activity = createSlotActivity();
    activity.applySeed(
      PORT,
      activity.beginSeed(PORT, T0),
      [{ slot: 0, state: "unknown", promptTokens: null, decoded: null }],
      T0,
    );
    expect(activity.needsSeed(PORT, T0, 1)).toBe(false);
    expect(activity.needsSeed(PORT, T0 + SLOT_STALE_MS, 1)).toBe(true);
  });

  it("never seeds a rate, because /slots does not carry one", () => {
    const activity = createSlotActivity();
    activity.applySeed(
      PORT,
      activity.beginSeed(PORT, T0),
      [{ slot: 0, state: "processing", promptTokens: 900, decoded: 40 }],
      T0,
    );
    const state = activity.resolve(PORT, T0).get(0);
    expect(state?.state).toBe("processing");
    expect(state?.promptTokens).toBe(900);
    expect(state?.rateTps).toBeNull();
  });
});
