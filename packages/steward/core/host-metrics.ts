/**
 * The host-metrics seam: the contract between Steward and whatever collector a
 * machine runs to measure its own GPU/CPU/memory.
 *
 * A collector is an operator-declared command (see `steward.json`) that streams
 * NDJSON to stdout, one reading per line, tagged with a schema so a stray
 * process cannot be mistaken for one of ours. This module owns the wire schema
 * and its validator, plus the injectable {@link HostMetricsProvider} the live
 * source reads. The Node implementation that spawns the command and drains its
 * stdout lives in `server/host-collector.ts`; the parser is here, Node-free, so
 * both the browser type-check and unit tests can reach it — mirroring how
 * {@link import("./llama-source.js").ServiceProbe} keeps its interface in `core/`
 * and its Node body in `server/`.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

/**
 * The schema tag every collector line must carry. A line without it — even one
 * that is otherwise valid JSON — is not a Steward reading and is dropped, so a
 * collector command that accidentally prints other JSON to stdout cannot inject
 * garbage into the host band.
 */
export const HOST_METRICS_SCHEMA = "steward.hostmetrics/1";

/**
 * One validated host reading. Every metric field is `number | null`: `null`
 * means "this machine cannot measure it" (a dashed/hatched gauge), never a real
 * zero. `ts` is the producer's own clock, retained for diagnostics; staleness is
 * judged on arrival wall-clock (see {@link HostSample.receivedAt}), not on this.
 *
 * Field names mirror {@link import("./types.js").HostMetrics} so the overlay is a
 * straight copy. A `unified`-memory machine simply omits the VRAM fields (they
 * arrive `null`); it exposes no readable VRAM total and one is never synthesised.
 */
export interface HostReading {
  /** Producer timestamp, epoch ms. Required — a line missing it is malformed. */
  ts: number;
  /** GPU utilisation, 0–1. */
  gpuUtil: number | null;
  gpuTempC: number | null;
  /** CPU utilisation, 0–1. */
  cpuUtil: number | null;
  cpuTempC: number | null;
  ramUsedGB: number | null;
  ramTotalGB: number | null;
  vramUsedGB: number | null;
  vramTotalGB: number | null;
}

/** The most recent validated reading, plus the wall-clock at which it arrived. */
export interface HostSample {
  reading: HostReading;
  /** Arrival wall-clock, epoch ms — the clock staleness is measured against. */
  receivedAt: number;
}

/**
 * The live source's view of the host collector: the latest sample (or `null`
 * before the first one lands, or after the collector has been given up on), and
 * a way to release the underlying process. Injected into the otherwise Node-free
 * {@link import("./llama-source.js").LlamaSource}; the Node body is
 * `createHostCollector`.
 */
export interface HostMetricsProvider {
  /** The most recent validated reading, or `null` when there is none. */
  latest(): HostSample | null;
  /** Releases the collector process group. Safe to call more than once. */
  close(): void;
}

/** True only for a real, finite number — the same bar the gauges hold readings to. */
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A finite reading, or `null` for anything else (missing, `null`, NaN, wrong type). */
function readingField(value: unknown): number | null {
  return finiteNumber(value) ? value : null;
}

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates one NDJSON line against the host-metrics schema, returning the
 * reading or `null` when the line is not one of ours.
 *
 * The contract (plan H2): the `schema` tag and a numeric `ts` are REQUIRED — a
 * line that parses but is missing either is MALFORMED and dropped, never turned
 * into an all-`null` sample that would read as "measured nothing". Each metric
 * field, in contrast, is optional and independently `number | null`: absent,
 * `null`, or a non-finite value all become `null` (a no-reading gauge), while a
 * finite number rides through. Malformed JSON, a non-object, or an array all
 * yield `null`. This function never throws.
 */
export function parseHostMetricsLine(line: string): HostReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema !== HOST_METRICS_SCHEMA) return null;
  if (!finiteNumber(parsed.ts)) return null;

  return {
    ts: parsed.ts,
    gpuUtil: readingField(parsed.gpuUtil),
    gpuTempC: readingField(parsed.gpuTempC),
    cpuUtil: readingField(parsed.cpuUtil),
    cpuTempC: readingField(parsed.cpuTempC),
    ramUsedGB: readingField(parsed.ramUsedGB),
    ramTotalGB: readingField(parsed.ramTotalGB),
    vramUsedGB: readingField(parsed.vramUsedGB),
    vramTotalGB: readingField(parsed.vramTotalGB),
  };
}
