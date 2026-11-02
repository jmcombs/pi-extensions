import { describe, expect, it } from "vitest";
import type { OmlxModelStatus, OmlxStatusRow } from "./client.js";
import { loadRatio } from "./progress.js";

function loadingRow(overrides: Partial<OmlxStatusRow> = {}): OmlxStatusRow {
  return {
    id: "probe",
    loaded: false,
    is_loading: true,
    model_type: "llm",
    engine_type: "batched",
    model_format: null,
    model_context_length: 32768,
    thinking_default: null,
    reasoning_efforts: null,
    is_hidden: false,
    model_alias: null,
    estimated_size: 1024 ** 3,
    loading_started_at: 0,
    ...overrides,
  };
}

function status(overrides: Partial<OmlxModelStatus> = {}): OmlxModelStatus {
  return {
    models: [],
    load_seconds_per_gb_estimate: 2,
    load_time_observations: 2,
    ...overrides,
  };
}

describe("loadRatio", () => {
  it("returns undefined under two observations", () => {
    const row = loadingRow();
    expect(loadRatio(row, status({ load_time_observations: 0 }), 10)).toBeUndefined();
    expect(loadRatio(row, status({ load_time_observations: 1 }), 10)).toBeUndefined();
  });

  it("uses a 3 second floor", () => {
    // 1 GiB at 0.1 s/GB estimates 1.1s. Without the floor that elapsed ratio
    // exceeds 1 and would cap. The floor keeps the denominator at 3s.
    const ratio = loadRatio(
      loadingRow({ estimated_size: 1024 ** 3 }),
      status({ load_seconds_per_gb_estimate: 0.1, load_time_observations: 2 }),
      1.5,
    );
    expect(ratio).toBeCloseTo(0.5);
  });

  it("caps the ratio below 1", () => {
    // 10 GiB at 2 s/GB estimates 21s. 100s elapsed would be ~4.8 without the cap.
    const ratio = loadRatio(
      loadingRow({ estimated_size: 10 * 1024 ** 3 }),
      status({ load_seconds_per_gb_estimate: 2, load_time_observations: 4 }),
      100,
    );
    expect(ratio).toBe(0.99);
    expect(ratio).toBeLessThan(1);
  });

  it("does not cap a ratio that is already below 1", () => {
    const ratio = loadRatio(
      loadingRow({ estimated_size: 10 * 1024 ** 3 }),
      status({ load_seconds_per_gb_estimate: 2, load_time_observations: 2 }),
      10.5,
    );
    expect(ratio).toBeCloseTo(0.5);
  });
});
