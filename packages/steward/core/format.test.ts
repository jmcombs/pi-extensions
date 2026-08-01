import { describe, expect, it } from "vitest";
import {
  barPercent,
  bitsFromCode,
  contextHeadroomColor,
  formatClock,
  formatContextField,
  formatFlashField,
  formatGpuLayersField,
  formatKvBits,
  formatKvCacheField,
  formatLogText,
  formatMemory,
  formatPercent,
  formatQuantField,
  formatSizeField,
  formatSizeGB,
  formatTemperature,
  formatTokenCount,
  formatTps,
  formatTypeField,
  formatUptime,
  NA,
  temperatureBarPercent,
  temperatureColor,
} from "./format.js";

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
    expect(formatTemperature(64.4, "celsius")).toBe("64°C");
    expect(formatTemperature(64.6, "celsius")).toBe("65°C");
  });

  it("labels whole degrees in Fahrenheit too", () => {
    expect(formatTemperature(64, "fahrenheit")).toBe("147°F");
    expect(formatTemperature(100, "fahrenheit")).toBe("212°F");
  });

  it("rounds after converting, not before", () => {
    // 64.4 °C is 147.92 °F. Rounding the Celsius reading first would give 64 °C
    // → 147 °F and quietly lose half a degree on every Fahrenheit label.
    expect(formatTemperature(64.4, "fahrenheit")).toBe("148°F");
  });

  it("handles zero and negatives in both units", () => {
    expect(formatTemperature(0, "celsius")).toBe("0°C");
    expect(formatTemperature(0, "fahrenheit")).toBe("32°F");
    expect(formatTemperature(-40, "celsius")).toBe("-40°C");
    // The one reading that is the same number in both.
    expect(formatTemperature(-40, "fahrenheit")).toBe("-40°F");
    expect(formatTemperature(-17.8, "fahrenheit")).toBe("0°F");
  });

  /**
   * The constraint the whole change turns on. A converted reading compared
   * against a Celsius threshold reads 79 °C as 174 against 75 and paints every
   * gauge critical, so the unit must reach the LABEL and nothing else.
   */
  it("judges the reading, not the label — a Fahrenheit number is never compared", () => {
    // 79 °C is a warning. Its label in Fahrenheit is 174, which against the same
    // thresholds would read as an error and paint a healthy box critical, so the
    // color is asserted on the reading and the Fahrenheit figure is asserted to
    // be exactly the number that must never reach the comparison.
    expect(temperatureColor(79)).toBe("var(--warning)");
    expect(formatTemperature(79, "fahrenheit")).toBe("174°F");
    expect(temperatureColor(174)).toBe("var(--error)");

    // Same shape at the other end: a cool 47 °C bar sits at 26%, and its 117 °F
    // label would peg the same bar at 100%.
    expect(temperatureBarPercent(47)).toBe(26);
    expect(formatTemperature(47, "fahrenheit")).toBe("117°F");
    expect(temperatureBarPercent(117)).toBe(100);
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

describe("bitsFromCode", () => {
  it("reads the first run of digits as a bit-depth", () => {
    expect(bitsFromCode("Q4_0")).toBe("4-bit");
    expect(bitsFromCode("Q5_K_M")).toBe("5-bit");
    expect(bitsFromCode("F16")).toBe("16-bit");
    expect(bitsFromCode("q8_0")).toBe("8-bit");
  });

  it("reads the depth from anywhere in a non-standard code, not just the front", () => {
    // The digits are not always leading: i-quants prefix with `IQ`, some formats
    // put the width mid-string. The bit-depth is still the first run of digits.
    expect(bitsFromCode("IQ2_XXS")).toBe("2-bit");
    expect(bitsFromCode("IQ4_NL")).toBe("4-bit");
    expect(bitsFromCode("MXFP4")).toBe("4-bit");
    expect(bitsFromCode("BF16")).toBe("16-bit");
    expect(bitsFromCode("TQ1_0")).toBe("1-bit");
  });

  it("is empty when the code carries no digits", () => {
    expect(bitsFromCode("")).toBe("");
    expect(bitsFromCode("IQ")).toBe("");
  });
});

describe("formatKvBits", () => {
  it("collapses the two sides to one bit-depth when they match", () => {
    expect(formatKvBits("q8_0/q8_0")).toBe("8-bit");
    expect(formatKvBits("f16/f16")).toBe("16-bit");
  });

  it("keeps them split when K and V differ", () => {
    expect(formatKvBits("q8_0/q5_1")).toBe("8-bit / 5-bit");
  });

  it("falls back to the raw side when a side has no digits", () => {
    expect(formatKvBits("iq/iq")).toBe("iq");
  });
});

describe("formatQuantField", () => {
  it("leads with the bit-depth reading and keeps the code beside it", () => {
    expect(formatQuantField("Q4_0", true)).toBe("4-bit (Q4_0)");
    expect(formatQuantField("Q5_K_M", true)).toBe("5-bit (Q5_K_M)");
  });

  it("is n/a when the model is not confirmed, whatever the guessed code", () => {
    expect(formatQuantField("Q4_0", false)).toBe(NA);
  });

  it("is n/a when the code carries no digits to read a depth from", () => {
    expect(formatQuantField("", true)).toBe(NA);
    expect(formatQuantField("IQ", true)).toBe(NA);
  });
});

describe("formatSizeField", () => {
  it("renders the on-disk size in GB when loaded", () => {
    expect(formatSizeField(0.42, true)).toBe("0.42 GB");
    expect(formatSizeField(18.4, true)).toBe("18.4 GB");
  });

  it("is n/a when unconfirmed or when there is no meta to report a size", () => {
    expect(formatSizeField(0.42, false)).toBe(NA);
    expect(formatSizeField(null, true)).toBe(NA);
  });
});

describe("formatContextField", () => {
  it("renders the per-slot window and never a trained-max clause", () => {
    expect(formatContextField(40960, true)).toBe("40k / slot");
    expect(formatContextField(8192, true)).toBe("8k / slot");
  });

  it("is n/a when unconfirmed or unknown", () => {
    expect(formatContextField(40960, false)).toBe(NA);
    expect(formatContextField(null, true)).toBe(NA);
  });
});

describe("formatGpuLayersField", () => {
  it("renders the requested count as-is, sentinel and all", () => {
    expect(formatGpuLayersField(48, true)).toBe("48");
    expect(formatGpuLayersField(99, true)).toBe("99");
    expect(formatGpuLayersField(0, true)).toBe("0");
  });

  it("is n/a when never pinned — including a loaded model whose layers are unreported", () => {
    expect(formatGpuLayersField(null, true)).toBe(NA);
    expect(formatGpuLayersField(48, false)).toBe(NA);
  });
});

describe("formatFlashField", () => {
  it("title-cases the on/off/auto enum when loaded", () => {
    expect(formatFlashField("on", true)).toBe("On");
    expect(formatFlashField("off", true)).toBe("Off");
    // Auto can stand even loaded — the resolved value is not reported back.
    expect(formatFlashField("auto", true)).toBe("Auto");
  });

  it("is n/a until loaded", () => {
    expect(formatFlashField("on", false)).toBe(NA);
  });
});

describe("formatKvCacheField", () => {
  it("collapses the two sides to one bit-depth when they match", () => {
    expect(formatKvCacheField("q8_0/q8_0", true)).toBe("8-bit");
    expect(formatKvCacheField("f16/f16", true)).toBe("16-bit");
  });

  it("keeps the sides split when K and V differ", () => {
    expect(formatKvCacheField("q8_0/q5_1", true)).toBe("8-bit / 5-bit");
  });

  it("is n/a until loaded", () => {
    expect(formatKvCacheField("q8_0/q8_0", false)).toBe(NA);
  });
});

describe("formatTypeField", () => {
  it("names the modality and is never n/a — it is confirmed even unloaded", () => {
    expect(formatTypeField(false)).toBe("Generative");
    expect(formatTypeField(true)).toBe("Embedder");
  });
});

describe("contextHeadroomColor", () => {
  it("escalates tertiary → warning → error across the thresholds", () => {
    expect(contextHeadroomColor(61)).toBe("var(--text-tertiary)");
    expect(contextHeadroomColor(85)).toBe("var(--text-tertiary)");
    expect(contextHeadroomColor(86)).toBe("var(--warning)");
    expect(contextHeadroomColor(97)).toBe("var(--warning)");
    expect(contextHeadroomColor(98)).toBe("var(--error)");
    expect(contextHeadroomColor(100)).toBe("var(--error)");
  });
});

describe("formatLogText", () => {
  it("writes one `HH:MM:SS.mmm LEVEL model message` line per row", () => {
    expect(
      formatLogText([
        {
          time: "09:04:07.042",
          level: "INFO",
          model: "qwen3.6-moe-a3b-instruct",
          frameRaw: "",
          message: "a b",
        },
        {
          time: "09:04:08.100",
          level: "WARN",
          model: "qwen3.6-moe-coder-fim",
          frameRaw: "",
          message: "c",
        },
      ]),
    ).toBe(
      "09:04:07.042 INFO qwen3.6-moe-a3b-instruct a b\n09:04:08.100 WARN qwen3.6-moe-coder-fim c",
    );
  });

  it("writes the relocated frame back in front of the message", () => {
    // The task column took `id  0 | task 81259 | ` out of the message; an
    // export that did not put it back would be a reassembly of the file rather
    // than the file, and the whole relocation would be a rewrite.
    expect(
      formatLogText([
        {
          time: "09:04:07.042",
          level: "INFO",
          model: "gpt-oss-20b",
          frameRaw: "slot      release: id  0 | task 81259 | ",
          message: "stop processing: n_tokens = 193, truncated = 0",
        },
      ]),
    ).toBe(
      "09:04:07.042 INFO gpt-oss-20b slot      release: id  0 | task 81259 | stop processing: n_tokens = 193, truncated = 0",
    );
  });

  it("is empty for an empty console", () => {
    expect(formatLogText([])).toBe("");
  });
});
