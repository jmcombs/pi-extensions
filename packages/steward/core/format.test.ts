import { describe, expect, it } from "vitest";
import {
  barPercent,
  formatClock,
  formatLogText,
  formatMemory,
  formatModelMeta,
  formatModelTuning,
  formatPercent,
  formatSizeGB,
  formatTemperature,
  formatTokenCount,
  formatTps,
  formatUptime,
  temperatureBarPercent,
  temperatureColor,
} from "./format.js";
import type { ModelInfo } from "./types.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe("formatUptime", () => {
  it("renders hours and zero-padded minutes", () => {
    expect(formatUptime(3 * HOUR + 34 * MINUTE)).toBe("3h 34m");
    expect(formatUptime(2 * HOUR + 4 * MINUTE)).toBe("2h 04m");
    expect(formatUptime(0)).toBe("0h 00m");
  });

  it("drops the sub-minute remainder rather than rounding up", () => {
    expect(formatUptime(59_999)).toBe("0h 00m");
    expect(formatUptime(MINUTE + 59_999)).toBe("0h 01m");
  });

  it("does not go negative when the clocks disagree", () => {
    expect(formatUptime(-5000)).toBe("0h 00m");
  });

  it("keeps counting past a day", () => {
    expect(formatUptime(49 * HOUR + 7 * MINUTE)).toBe("49h 07m");
  });
});

describe("formatClock", () => {
  it("renders local wall time with milliseconds", () => {
    // Built from local components, so the assertion holds in any time zone.
    const ts = new Date(2024, 0, 15, 9, 4, 7, 42).getTime();
    expect(formatClock(ts)).toBe("09:04:07.042");
  });

  it("pads every field", () => {
    expect(formatClock(new Date(2024, 5, 1, 0, 0, 0, 5).getTime())).toBe("00:00:00.005");
    expect(formatClock(new Date(2024, 5, 1, 23, 59, 59, 999).getTime())).toBe("23:59:59.999");
  });
});

describe("formatPercent and barPercent", () => {
  it("rounds fractions to whole percent", () => {
    expect(formatPercent(0.78)).toBe("78%");
    expect(formatPercent(0.176)).toBe("18%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("reports overshoot in the label but clamps the bar", () => {
    expect(formatPercent(1.2)).toBe("120%");
    expect(barPercent(1.2)).toBe(100);
    expect(barPercent(-0.4)).toBe(0);
  });

  it("treats a non-finite ratio as empty", () => {
    expect(barPercent(Number.NaN)).toBe(0);
    expect(barPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("temperature gauges", () => {
  it("colors by the design's thresholds", () => {
    expect(temperatureColor(47)).toBe("var(--success)");
    expect(temperatureColor(75)).toBe("var(--success)");
    expect(temperatureColor(75.1)).toBe("var(--warning)");
    expect(temperatureColor(85)).toBe("var(--warning)");
    expect(temperatureColor(85.1)).toBe("var(--error)");
    expect(temperatureColor(94)).toBe("var(--error)");
  });

  it("maps 30–95 °C onto the full bar", () => {
    expect(temperatureBarPercent(30)).toBe(0);
    expect(temperatureBarPercent(62.5)).toBe(50);
    expect(temperatureBarPercent(95)).toBe(100);
  });

  it("clamps readings outside the plotted band", () => {
    expect(temperatureBarPercent(12)).toBe(0);
    expect(temperatureBarPercent(120)).toBe(100);
  });

  it("labels whole degrees", () => {
    expect(formatTemperature(64.4)).toBe("64°C");
    expect(formatTemperature(64.6)).toBe("65°C");
  });
});

describe("formatMemory", () => {
  it("gives VRAM a decimal and RAM none", () => {
    expect(formatMemory(29.83, 48, 1)).toBe("29.8 / 48 GB");
    expect(formatMemory(52.4, 128, 0)).toBe("52 / 128 GB");
  });
});

describe("formatSizeGB", () => {
  it("keeps up to two decimals and trims trailing zeros", () => {
    expect(formatSizeGB(18.4)).toBe("18.4");
    expect(formatSizeGB(0.5)).toBe("0.5");
    // 423018496 bytes / 1e9 — the real small model in the fixtures.
    expect(formatSizeGB(0.423018496)).toBe("0.42");
    expect(formatSizeGB(22)).toBe("22");
  });
});

describe("formatTokenCount", () => {
  it("prints small counts whole and larger ones in binary thousands", () => {
    expect(formatTokenCount(27)).toBe("27");
    expect(formatTokenCount(40960)).toBe("40k");
    expect(formatTokenCount(65536)).toBe("64k");
    expect(formatTokenCount(8192)).toBe("8k");
    expect(formatTokenCount(12400)).toBe("12.1k");
  });

  it("dashes to zero on a non-count instead of NaN", () => {
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("formatTps", () => {
  it("rounds a rate and dashes a missing one", () => {
    expect(formatTps(63.4)).toBe("63 t/s");
    expect(formatTps(null)).toBe("—");
    expect(formatTps(Number.NaN)).toBe("—");
  });
});

describe("formatModelMeta", () => {
  const base: ModelInfo = {
    id: "qwen3.6-moe-a3b-instruct-q4_k_m",
    short: "qwen3.6-moe-a3b-instruct",
    embedding: false,
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    gpuLayers: 48,
    detail: null,
    parallel: 4,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
    status: "active",
    tokensPerSecond: 63,
  };

  it("renders the layer count when there is one", () => {
    expect(formatModelMeta(base)).toBe("Q4_K_M · 18.4 GB · ctx 65536 · 48 gpu layers");
  });

  it("falls back to the model's own detail for embedders", () => {
    const embed: ModelInfo = {
      ...base,
      id: "nomic-embed-text-v1.5-f16",
      short: "nomic-embed-text-v1.5",
      embedding: true,
      quant: "F16",
      sizeGB: 0.5,
      ctx: 8192,
      gpuLayers: null,
      detail: "embedding",
      status: "resident",
      tokensPerSecond: null,
    };
    expect(formatModelMeta(embed)).toBe("F16 · 0.5 GB · ctx 8192 · embedding");
  });

  it("omits the tail entirely when neither is available", () => {
    expect(formatModelMeta({ ...base, gpuLayers: null, detail: null })).toBe(
      "Q4_K_M · 18.4 GB · ctx 65536",
    );
  });

  it("shows the quant and lifecycle word when the model is not loaded", () => {
    expect(formatModelMeta({ ...base, sizeGB: null, ctx: null, status: "unloaded" })).toBe(
      "Q4_K_M · unloaded",
    );
    expect(
      formatModelMeta({ ...base, quant: "", sizeGB: null, ctx: null, status: "downloading" }),
    ).toBe("downloading");
  });
});

describe("formatModelTuning", () => {
  const base: ModelInfo = {
    id: "qwen3.6-moe-a3b-instruct-q4_k_m",
    short: "qwen3.6-moe-a3b-instruct",
    embedding: false,
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    gpuLayers: 48,
    detail: null,
    parallel: 4,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
    status: "active",
    tokensPerSecond: 63,
  };

  it("renders the preset tuning line", () => {
    expect(formatModelTuning(base)).toBe("4 slots · flash on · kv q8_0/q8_0");
  });

  it("reflects a model's own parallel, flash-attn and cache settings", () => {
    expect(formatModelTuning({ ...base, parallel: 2, flashAttn: "off", kvCache: "f16/f16" })).toBe(
      "2 slots · flash off · kv f16/f16",
    );
  });

  it("drops the slot count when it is unknown", () => {
    expect(formatModelTuning({ ...base, parallel: null })).toBe("flash on · kv q8_0/q8_0");
  });
});

describe("formatLogText", () => {
  it("writes one `HH:MM:SS.mmm LEVEL model message` line per row", () => {
    expect(
      formatLogText([
        { time: "09:04:07.042", level: "INFO", model: "qwen3.6-moe-a3b-instruct", message: "a b" },
        { time: "09:04:08.100", level: "WARN", model: "qwen3.6-moe-coder-fim", message: "c" },
      ]),
    ).toBe(
      "09:04:07.042 INFO qwen3.6-moe-a3b-instruct a b\n09:04:08.100 WARN qwen3.6-moe-coder-fim c",
    );
  });

  it("is empty for an empty console", () => {
    expect(formatLogText([])).toBe("");
  });
});
