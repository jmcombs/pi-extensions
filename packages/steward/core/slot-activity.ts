/**
 * Slot occupancy, derived from the server's own log instead of polled.
 *
 * `/slots?model=X` and `/metrics?model=X` are per-model, so the router proxies
 * each one to the child and writes a `proxy_reques:` line for it. Asking both,
 * for every loaded model, on the dashboard's 1.6 s repaint clock made Steward
 * the single loudest writer in the log it exists to display — a measured 86.9%
 * of one real corpus, ~1 line per second, most of it Steward watching itself.
 *
 * It was also *sampled*, and that is the part an operator actually noticed: a
 * request shorter than the poll interval begins and ends between two reads and
 * is never seen at all. On the measured workload — 11,343 requests averaging
 * ~0.9 s against a 1.6 s clock — the slots panel read idle while the server was
 * working. (Under continuous load the same panel reads busy every time, which is
 * how we know it is a sampling limit and not a regression.)
 *
 * The log has the answer already, is already being tailed, and costs nothing
 * more to read. Every `SLT_*` macro emits one shared, byte-stable frame —
 * `id %2d | task %d | ` — which the parser has already lifted off the message,
 * and the events that bracket a request are unambiguous:
 *
 * ```
 * slot get_availabl: id  0 | task -1    | selected slot by LCP similarity, …
 * slot launch_slot_: id  0 | task 836989 | processing task, is_child = 0
 * slot print_timing: id  0 | task 836989 | prompt processing, n_tokens = 16385, progress = 0.85, …
 * slot print_timing: id  0 | task 836989 | n_decoded = 663, tg = 110.43 t/s, tg_3s = 109.88 t/s
 * slot print_timing: id  0 | task 836989 |        eval time = 697.41 ms / 90 tokens (…, 129.05 tokens per second)
 * slot      release: id  0 | task 836989 | stop processing: n_tokens = 163, truncated = 0
 * ```
 *
 * Two shapes in there are worth calling out, because a parser written from the
 * llama.cpp source rather than from a real log gets both wrong. The function
 * name is printed right-aligned in a twelve-wide field, so it is
 * `slot      release:` with five leading spaces and never `slot release:` — but
 * that is the *frame's* problem, not this module's: every rule below reads the
 * post-frame message, where the payload is. And `prompt eval time = …` (prefill)
 * sits one word away from `eval time = …` (generation); only the second is a
 * generation rate, so the generation rule is anchored to the start of the
 * message where the word `prompt` cannot precede it.
 *
 * What this module deliberately does NOT do is invent the parts the log does not
 * carry. `requests_deferred` — the queue behind the slots — has no log line at
 * all, so nothing here reports it. How many slots a model has and how large each
 * one's context is are *structure*, not occupancy: they come from `/v1/models`,
 * which the router answers itself and logs nothing for.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`. It holds no
 * clock either: every time it needs one it is given the caller's.
 */

import type { LogLine, SlotState } from "./types.js";

/** One slot's occupancy as the event stream last established it. */
export interface SlotActivityState {
  /** Per-model slot index, from 0. */
  slot: number;
  state: SlotState;
  /** The task the slot is running, or `null` when it holds none. */
  task: number | null;
  /** Tokens the slot's context holds, or `null` when nothing has said. */
  promptTokens: number | null;
  /** Tokens generated so far this turn, or `null` while unmeasured. */
  decoded: number | null;
  /**
   * Measured generation rate for the request in this slot, or `null`. Only ever
   * a reading: it is cleared when a request starts and when one ends, so it can
   * never outlive the request it was measured for.
   */
  rateTps: number | null;
}

/** One slot of a one-shot `/slots` read, as {@link SlotActivity.applySeed} takes it. */
export interface SlotActivitySeed {
  slot: number;
  /** What the read said, `unknown` included — a body with no `is_processing`
   * establishes nothing, and seeding it as idle would invent the answer. */
  state: SlotState;
  promptTokens: number | null;
  decoded: number | null;
}

/**
 * How many one-shot `/slots` reads a port may spend establishing itself before
 * Steward gives up and waits for the log to say something. Bounded so a router
 * that answers `/slots` with an error can never turn the seed into the poll it
 * replaced.
 */
export const MAX_SEED_ATTEMPTS = 3;

/**
 * How long a slot may sit `processing` with nothing further said about it before
 * its state is treated as `unknown` rather than believed.
 *
 * This is the answer to a missed `release`. A stream can lose lines — the tailer
 * re-anchors when the file is replaced or truncated, a restarted Steward starts
 * from a backlog window, `com.apple.tmp_cleaner` deletes the file outright — and
 * a `release` in the lost window would otherwise leave a slot busy forever.
 *
 * **A running request does NOT reliably re-arm this, and nothing here should be
 * written as though it does.** llama.cpp's `print_timings_tg()` is gated on BOTH
 * `n_decoded >= 100` AND ~3 s elapsed, so a generation that is slow but short —
 * 60 tokens at 0.4 t/s is 150 s of work — emits no running readout at all and
 * crosses this bound in complete silence. The `tg_3s` line only covers requests
 * that are long in TOKENS, which is a strict subset of the requests that are long
 * in TIME.
 *
 * What actually protects a long request is the seed. Crossing the bound makes
 * {@link SlotActivity.needsSeed} true, and the caller's `needsSeed` check runs
 * BEFORE its `resolve` in the same snapshot — so a one-shot `/slots` read lands
 * first, answers `is_processing: true`, and restores `processing` with a fresh
 * timestamp. The demotion is real but never reaches the dashboard. Delete that
 * seed fallback believing this bound is self-correcting and a slow short
 * generation starts misreporting as `unknown` — the two mechanisms are one
 * design, not a mechanism and a redundancy.
 *
 * Resolving to `unknown` — never to `idle` — is what keeps the fallback honest
 * when the seed cannot answer either: a timeout is evidence that we lost track,
 * not evidence that the request finished.
 */
export const SLOT_STALE_MS = 120_000;

export interface SlotActivity {
  /**
   * Folds one log line into slot state. Lines that are not a slot event — no
   * `[port]` prefix, no pipe frame, a payload none of the rules match — are
   * ignored, which is most of the log.
   */
  observe(line: LogLine): void;
  /**
   * Whether a one-shot `/slots` read is warranted for `port`: it has never been
   * established, a lane went stale, or a lane is still unresolved. False once the
   * port is settled and its budget is spent.
   *
   * `expectedLanes` is what the model's `--parallel` says it has, or `null` when
   * that is not stated. The tracker cannot know it on its own — it only learns a
   * lane exists when the log mentions one — so a `--parallel 4` model whose
   * traffic all lands in lane 0 looks fully settled from in here. Passing the
   * declared count is what lets lanes 1–3 be recognised as never established.
   *
   * This is never a timer. A never-seen port costs at most
   * {@link MAX_SEED_ATTEMPTS} reads; after that a port with unresolved lanes is
   * retried no more often than once per {@link SLOT_STALE_MS}, which is ~75×
   * slower than the snapshot clock this replaced.
   */
  needsSeed(port: number, now: number, expectedLanes?: number | null): boolean;
  /**
   * Records that a seed read is being issued and returns the watermark to stamp
   * it with — the sequence number of the last line already folded in. The read
   * is asynchronous, so events can land while it is in flight; passing this back
   * to {@link applySeed} is what stops an older HTTP answer overwriting a newer
   * event.
   */
  beginSeed(port: number, now: number): number;
  /**
   * Applies a completed seed read, slot by slot, skipping any slot a log event
   * has spoken for since `watermark`. Marks the port established.
   */
  applySeed(port: number, watermark: number, slots: readonly SlotActivitySeed[], now: number): void;
  /**
   * This port's slots, keyed by slot index, with staleness applied as of `now`.
   * A port nothing is known about yields an empty map — the caller renders its
   * model's slots `unknown`, which is what it is.
   */
  resolve(port: number, now: number): ReadonlyMap<number, SlotActivityState>;
  /**
   * Forgets every port not in `ports` — a child that exited. Its slot ids and
   * task ids belong to a process that no longer exists, and a model reloaded on
   * a fresh port must not inherit them.
   */
  retain(ports: Iterable<number>): void;
  /**
   * Declares the event stream discontinuous: every slot goes `unknown` and every
   * port becomes eligible to be seeded again. For a tailer that reconnected, a
   * log file that came back, or any other break across which state cannot be
   * carried.
   */
  resync(): void;
}

/** `processing task, is_child = 0` — the slot took a task. */
const LAUNCH = /^processing task\b/;

/** `stop processing: n_tokens = 165, truncated = 0` — the slot gave it back. */
const RELEASE = /^stop processing\b/;

/** The `n_tokens = N` a release reports: the context the slot now holds. */
const RELEASE_TOKENS = /\bn_tokens\s*=\s*(\d+)/;

/**
 * `n_decoded = 663, tg = 110.43 t/s, tg_3s = 109.88 t/s` — the in-flight readout,
 * and the only live generation rate the log carries. See {@link SLOT_STALE_MS}
 * for what it does NOT cover: it needs 100 decoded tokens as well as ~3 s.
 *
 * Two rates are printed and they are not the same measurement. `tg` is the mean
 * since the request began; `tg_3s` is the last ~3 seconds. A tile that says what
 * the server is doing *now* wants the second, so it is preferred and `tg` is the
 * fallback for a build that prints only the one. On the first readout of a
 * request the two are equal, so nothing jumps when the window fills.
 */
const LIVE_DECODED = /\bn_decoded\s*=\s*(\d+)/;
const LIVE_TG_3S = /\btg_3s\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*t\/s/;
const LIVE_TG = /\btg\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*t\/s/;

/**
 * `        eval time =     697.41 ms /    90 tokens (…,   129.05 tokens per second)`
 * — the completed request's generation timing.
 *
 * Anchored at the start of the message so `prompt eval time = …`, which is
 * prefill and not a generation rate, cannot match it.
 */
const EVAL_TIMING =
  /^\s*eval time\s*=\s*[0-9.]+\s*ms\s*\/\s*(\d+)\s*tokens\s*\([^)]*?([0-9]+(?:\.[0-9]+)?)\s*tokens per second/;

/**
 * `prompt processing, n_tokens =  16385, progress = 0.85, t = 13.94 s / 1175.06 tokens per second`
 * — live prefill progress. Rare (long prompts only), so nothing depends on it;
 * when it is there it is the one thing that reports a slot's context filling up
 * while the request is still running.
 */
const PROMPT_PROGRESS = /^\s*prompt processing,\s*n_tokens\s*=\s*(\d+)/;

/** One slot's tracked state, plus the bookkeeping that keeps it honest. */
interface SlotRecord {
  state: SlotState;
  task: number | null;
  promptTokens: number | null;
  decoded: number | null;
  rateTps: number | null;
  /** `seq` of the last log line that spoke for this slot; 0 when only seeded. */
  lastSeq: number;
  /** When this record was last established, for the staleness bound. */
  updatedAt: number;
}

interface PortRecord {
  slots: Map<number, SlotRecord>;
  seedAttempts: number;
  seeded: boolean;
  /** Whether the current run of staleness has already refreshed the budget. */
  staleHandled: boolean;
  /** When the last seed read was issued, so a retry can be paced off the clock. */
  lastAttemptAt: number | null;
}

function blankRecord(now: number): SlotRecord {
  return {
    state: "unknown",
    task: null,
    promptTokens: null,
    decoded: null,
    rateTps: null,
    lastSeq: 0,
    updatedAt: now,
  };
}

/** A capture group as a finite number, or `null`. */
function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Tracks slot occupancy across every model the router runs, keyed by the child's
 * port.
 *
 * The port is the identity, not the model id: task ids and slot ids are
 * per-process counters that restart at 0 in every child, so a model unloaded and
 * reloaded gets a fresh port and, with it, a clean slate. Joining port to model
 * is the caller's job — it already has `/v1/models`, which states each loaded
 * child's `--port`.
 */
export function createSlotActivity(): SlotActivity {
  const ports = new Map<number, PortRecord>();

  /** The highest `seq` folded in, so a seed read can be stamped against it. */
  let watermark = 0;

  function port(number: number): PortRecord {
    const existing = ports.get(number);
    if (existing !== undefined) return existing;
    const created: PortRecord = {
      slots: new Map(),
      seedAttempts: 0,
      seeded: false,
      staleHandled: false,
      lastAttemptAt: null,
    };
    ports.set(number, created);
    return created;
  }

  function slot(record: PortRecord, id: number, now: number): SlotRecord {
    const existing = record.slots.get(id);
    if (existing !== undefined) return existing;
    const created = blankRecord(now);
    record.slots.set(id, created);
    return created;
  }

  /**
   * Whether a lane has been `processing` past the bound. This is the edge that
   * reopens a settled port for another seed read, and it is why a missed
   * `release` self-heals instead of pinning a chip on `busy` forever.
   */
  function hasStale(record: PortRecord, now: number): boolean {
    for (const entry of record.slots.values()) {
      if (entry.state === "processing" && now - entry.updatedAt > SLOT_STALE_MS) return true;
    }
    return false;
  }

  /**
   * Whether any lane's occupancy is still not established — one the log has
   * never mentioned, or one explicitly `unknown`.
   *
   * Staleness alone is not enough to catch this. A lane that is `unknown`
   * (because every seed read failed while the router was unwell) is not
   * `processing`, so it never trips the stale edge, and llama.cpp's LCP slot
   * affinity will happily send every request to lane 0 for hours — so no event
   * ever names lanes 1–3 either. Without this check those lanes sit `unknown`
   * for the life of the child process with nothing left that could ever ask.
   */
  function hasUnresolved(record: PortRecord, expectedLanes: number | null): boolean {
    for (const entry of record.slots.values()) {
      if (entry.state === "unknown") return true;
    }
    if (expectedLanes === null) return false;
    for (let id = 0; id < expectedLanes; id += 1) {
      if (!record.slots.has(id)) return true;
    }
    return false;
  }

  return {
    observe(line: LogLine): void {
      if (line.seq > watermark) watermark = line.seq;

      // A slot event is a child line carrying the SLT_* pipe frame. Everything
      // else in the log — the router's own lines, the boot banners, the proxy
      // records, a child's vocab warnings — has nothing to say about occupancy.
      const frame = line.frame;
      if (frame === undefined || line.port === undefined) return;
      // A frame llama.cpp emitted with no real slot (a future "none available"
      // path) is not a slot we can track, and tracking it as slot -1 would put a
      // phantom lane on a chip.
      if (frame.slot < 0) return;

      const record = port(line.port);
      const message = line.message;

      // `get_available_slot` runs before a task is attached, which is why its
      // frame reads `task -1` — and it only ever names a slot it found FREE. So
      // this line is a direct, exact idle observation, and the cheapest re-sync
      // the log offers: if we thought the slot was busy, its release was one of
      // the lines we lost.
      if (frame.task === -1) {
        const entry = slot(record, frame.slot, line.ts);
        entry.state = "idle";
        entry.task = null;
        entry.decoded = null;
        entry.rateTps = null;
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
        return;
      }

      if (LAUNCH.test(message)) {
        const entry = slot(record, frame.slot, line.ts);
        // A launch for a different task than the one we hold means that one's
        // release was missed. The new task is the truth; nothing of the old
        // one's readings survives into it.
        entry.state = "processing";
        entry.task = frame.task;
        entry.decoded = null;
        entry.rateTps = null;
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
        return;
      }

      if (RELEASE.test(message)) {
        const entry = slot(record, frame.slot, line.ts);
        entry.state = "idle";
        entry.task = null;
        // `n_tokens` here is the context the slot is left holding, and it stays
        // true until the next request reuses or evicts it — so it is the idle
        // slot's occupancy, not a leftover from a request that ended.
        entry.promptTokens = toNumber(RELEASE_TOKENS.exec(message)?.[1]) ?? entry.promptTokens;
        entry.decoded = null;
        entry.rateTps = null;
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
        return;
      }

      const decoded = LIVE_DECODED.exec(message);
      // The last ~3 seconds if the build prints it, else the mean since the
      // request began — both are measurements of this request, and neither is
      // ever carried past its release.
      const tg = LIVE_TG_3S.exec(message) ?? LIVE_TG.exec(message);
      if (decoded !== null && tg !== null) {
        // A running readout is also proof of occupancy: whatever we thought, this
        // slot is generating right now, on this task.
        const entry = slot(record, frame.slot, line.ts);
        entry.state = "processing";
        entry.task = frame.task;
        entry.decoded = toNumber(decoded[1]);
        entry.rateTps = toNumber(tg[1]);
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
        return;
      }

      const timing = EVAL_TIMING.exec(message);
      if (timing !== null) {
        // The completed request's own rate, printed microseconds before its
        // release. It counts while the slot is still holding the task and is
        // cleared by the release that follows — it is never carried into the
        // next request, or into the idle gap after this one.
        const entry = slot(record, frame.slot, line.ts);
        entry.state = "processing";
        entry.task = frame.task;
        entry.decoded = toNumber(timing[1]);
        entry.rateTps = toNumber(timing[2]);
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
        return;
      }

      const progress = PROMPT_PROGRESS.exec(message);
      if (progress !== null) {
        const entry = slot(record, frame.slot, line.ts);
        entry.state = "processing";
        entry.task = frame.task;
        entry.promptTokens = toNumber(progress[1]);
        entry.lastSeq = line.seq;
        entry.updatedAt = line.ts;
      }
    },

    needsSeed(number: number, now: number, expectedLanes: number | null = null): boolean {
      const record = ports.get(number);
      if (record === undefined) return true;

      // A lane we have lost track of means the stream and reality have come
      // apart, so the port is worth establishing again — and it gets a fresh
      // budget, because this is new uncertainty and not a retry of the old one.
      //
      // The budget is reset on the EDGE, once, and not while the condition
      // persists. Resetting it on every call would hand a port whose `/slots`
      // read keeps failing an unlimited retry on the snapshot clock, which is
      // the polling loop this change removed, rebuilt by accident.
      const stale = hasStale(record, now);
      if (stale && !record.staleHandled) {
        record.staleHandled = true;
        record.seeded = false;
        record.seedAttempts = 0;
      } else if (!stale) {
        record.staleHandled = false;
      }

      if (!record.seeded && record.seedAttempts < MAX_SEED_ATTEMPTS) return true;

      // The budget is spent, but a lane is still unresolved and no event is
      // coming for it. Try again — paced by the staleness bound, so this can
      // never approach the cadence it replaced. At worst a permanently
      // unresolvable port costs MAX_SEED_ATTEMPTS reads every SLOT_STALE_MS
      // (~1 read per 40 s), against the ~2 per 1.6 s the old path spent on a
      // model that was working perfectly.
      if (!hasUnresolved(record, expectedLanes)) return false;
      const since = record.lastAttemptAt;
      if (since !== null && now - since < SLOT_STALE_MS) return false;
      record.seeded = false;
      record.seedAttempts = 0;
      return true;
    },

    beginSeed(number: number, now: number): number {
      const record = port(number);
      record.seedAttempts += 1;
      record.lastAttemptAt = now;
      return watermark;
    },

    applySeed(
      number: number,
      stamp: number,
      slots: readonly SlotActivitySeed[],
      now: number,
    ): void {
      const record = port(number);
      record.seeded = true;
      record.seedAttempts = 0;
      for (const seeded of slots) {
        if (seeded.slot < 0) continue;
        const entry = slot(record, seeded.slot, now);
        // An event that landed while the read was in flight is newer than the
        // read and wins. Without this the answer to a 4 s HTTP call could undo
        // four seconds of live events.
        if (entry.lastSeq > stamp) continue;
        entry.state = seeded.state;
        entry.task = null;
        entry.promptTokens = seeded.promptTokens;
        entry.decoded = seeded.decoded;
        // A rate is never seeded: `/slots` does not carry one, and the
        // `/metrics` gauge that does holds its last value after generation ends,
        // which is exactly the stale number this change exists to stop showing.
        entry.rateTps = null;
        entry.updatedAt = now;
      }
    },

    resolve(number: number, now: number): ReadonlyMap<number, SlotActivityState> {
      const record = ports.get(number);
      if (record === undefined) return new Map();
      const resolved = new Map<number, SlotActivityState>();
      for (const [id, entry] of record.slots) {
        // Past the bound we have not been told this slot is still working; we
        // have only not been told that it stopped. Those are different, and only
        // one of them is `processing`.
        const stale = entry.state === "processing" && now - entry.updatedAt > SLOT_STALE_MS;
        resolved.set(id, {
          slot: id,
          state: stale ? "unknown" : entry.state,
          task: stale ? null : entry.task,
          promptTokens: entry.promptTokens,
          decoded: stale ? null : entry.decoded,
          rateTps: stale ? null : entry.rateTps,
        });
      }
      return resolved;
    },

    retain(keep: Iterable<number>): void {
      const live = new Set(keep);
      for (const number of [...ports.keys()]) {
        if (!live.has(number)) ports.delete(number);
      }
    },

    resync(): void {
      for (const record of ports.values()) {
        record.seeded = false;
        record.seedAttempts = 0;
        record.staleHandled = false;
        record.lastAttemptAt = null;
        record.slots.clear();
      }
    },
  };
}
