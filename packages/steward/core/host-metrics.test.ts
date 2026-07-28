/**
 * The wire contract for host readings: schema + `ts` are required, every metric
 * field is independently `number | null`, and a line that parses but misses the
 * required keys is MALFORMED (dropped) — never an all-`null` sample that would
 * read as a real "measured nothing". These prove the validator, apart from the
 * process plumbing that feeds it (which `server/host-collector.test.ts` covers).
 */

import { describe, expect, it } from "vitest";
import { HOST_METRICS_SCHEMA, parseHostMetricsLine } from "./host-metrics.js";

const VALID_DISCRETE = JSON.stringify({
  schema: HOST_METRICS_SCHEMA,
  ts: 1_785_300_000_000,
  gpuUtil: 0.6,
  gpuTempC: 72,
  cpuUtil: 0.4,
  cpuTempC: 55,
  vramUsedGB: 9.1,
  vramTotalGB: 24,
  ramUsedGB: 31,
  ramTotalGB: 64,
});

describe("parseHostMetricsLine", () => {
  it("reads a full discrete line into every field", () => {
    expect(parseHostMetricsLine(VALID_DISCRETE)).toEqual({
      ts: 1_785_300_000_000,
      gpuUtil: 0.6,
      gpuTempC: 72,
      cpuUtil: 0.4,
      cpuTempC: 55,
      vramUsedGB: 9.1,
      vramTotalGB: 24,
      ramUsedGB: 31,
      ramTotalGB: 64,
    });
  });

  it("nulls the fields a unified line omits, without synthesising VRAM", () => {
    const line = JSON.stringify({
      schema: HOST_METRICS_SCHEMA,
      ts: 1_785_300_000_000,
      gpuUtil: 0.31,
      gpuTempC: 41.9,
      cpuUtil: 0.18,
      cpuTempC: 41.2,
      ramUsedGB: 64.2,
      ramTotalGB: 128,
    });
    expect(parseHostMetricsLine(line)).toMatchObject({
      ramUsedGB: 64.2,
      ramTotalGB: 128,
      vramUsedGB: null,
      vramTotalGB: null,
    });
  });

  it("keeps an explicit null field as a no-reading, not a zero", () => {
    const line = JSON.stringify({
      schema: HOST_METRICS_SCHEMA,
      ts: 1,
      gpuTempC: null,
      cpuTempC: null,
    });
    const reading = parseHostMetricsLine(line);
    expect(reading?.gpuTempC).toBeNull();
    expect(reading?.cpuTempC).toBeNull();
    // A missing utilisation is also a no-reading, distinct from a real 0.
    expect(reading?.gpuUtil).toBeNull();
  });

  it("drops a line with no schema tag as malformed, not an all-null sample", () => {
    const line = JSON.stringify({ ts: 1, gpuUtil: 0.5 });
    expect(parseHostMetricsLine(line)).toBeNull();
  });

  it("drops a line carrying a foreign schema tag", () => {
    const line = JSON.stringify({ schema: "prometheus/1", ts: 1, gpuUtil: 0.5 });
    expect(parseHostMetricsLine(line)).toBeNull();
  });

  it("drops a line missing ts, or with a non-numeric ts", () => {
    expect(parseHostMetricsLine(JSON.stringify({ schema: HOST_METRICS_SCHEMA }))).toBeNull();
    expect(
      parseHostMetricsLine(JSON.stringify({ schema: HOST_METRICS_SCHEMA, ts: "soon" })),
    ).toBeNull();
    expect(
      parseHostMetricsLine(JSON.stringify({ schema: HOST_METRICS_SCHEMA, ts: Number.NaN })),
    ).toBeNull();
  });

  it("coerces a non-finite or wrong-typed metric field to a no-reading", () => {
    const line = JSON.stringify({
      schema: HOST_METRICS_SCHEMA,
      ts: 1,
      gpuUtil: "hot",
      cpuUtil: null,
      ramUsedGB: 8,
    });
    expect(parseHostMetricsLine(line)).toMatchObject({
      gpuUtil: null,
      cpuUtil: null,
      ramUsedGB: 8,
    });
  });

  it("returns null for malformed JSON, a bare value, or an array", () => {
    expect(parseHostMetricsLine("{not json")).toBeNull();
    expect(parseHostMetricsLine("")).toBeNull();
    expect(parseHostMetricsLine("42")).toBeNull();
    expect(parseHostMetricsLine('"a string"')).toBeNull();
    expect(parseHostMetricsLine("null")).toBeNull();
    expect(
      parseHostMetricsLine(JSON.stringify([{ schema: HOST_METRICS_SCHEMA, ts: 1 }])),
    ).toBeNull();
  });
});
