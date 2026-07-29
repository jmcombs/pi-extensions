import { describe, expect, it } from "vitest";
import {
  celsiusToFahrenheit,
  FAHRENHEIT_REGIONS,
  parseTemperaturePreference,
  regionFromLocale,
  resolveTemperatureUnit,
  temperatureUnitForLocale,
  temperatureUnitForLocales,
  unitForRegion,
} from "./temperature.js";

describe("regionFromLocale", () => {
  it("reads the region subtag, canonicalized", () => {
    expect(regionFromLocale("en-US")).toBe("US");
    expect(regionFromLocale("en-us")).toBe("US");
    expect(regionFromLocale("zh-Hant-TW")).toBe("TW");
    expect(regionFromLocale("de-DE-u-ca-buddhist")).toBe("DE");
  });

  it("has no region to report for a bare language", () => {
    expect(regionFromLocale("en")).toBeNull();
    // Deliberately NOT maximized: `en` is not evidence that anyone is in the US.
    expect(regionFromLocale("de")).toBeNull();
  });

  it("never throws on input that is not a locale", () => {
    expect(regionFromLocale("not a locale")).toBeNull();
    expect(regionFromLocale("")).toBeNull();
    expect(regionFromLocale("   ")).toBeNull();
    expect(regionFromLocale(undefined)).toBeNull();
    expect(regionFromLocale(null)).toBeNull();
    expect(regionFromLocale(42 as unknown as string)).toBeNull();
  });
});

describe("unitForRegion", () => {
  it("holds exactly the regions that read Fahrenheit", () => {
    expect([...FAHRENHEIT_REGIONS].sort()).toEqual(
      ["AS", "BS", "BZ", "FM", "GU", "KY", "LR", "MH", "MM", "MP", "PR", "PW", "US", "VI"].sort(),
    );
  });

  it("answers Celsius for everything else, including nothing at all", () => {
    expect(unitForRegion("US")).toBe("fahrenheit");
    expect(unitForRegion("us")).toBe("fahrenheit");
    expect(unitForRegion("GB")).toBe("celsius");
    expect(unitForRegion("ZZ")).toBe("celsius");
    expect(unitForRegion(null)).toBe("celsius");
    expect(unitForRegion(undefined)).toBe("celsius");
  });
});

describe("temperatureUnitForLocale", () => {
  it("maps a browser locale onto a unit by region", () => {
    expect(temperatureUnitForLocale("en-US")).toBe("fahrenheit");
    expect(temperatureUnitForLocale("en-GB")).toBe("celsius");
    expect(temperatureUnitForLocale("de-DE")).toBe("celsius");
    expect(temperatureUnitForLocale("en-LR")).toBe("fahrenheit");
    expect(temperatureUnitForLocale("my-MM")).toBe("fahrenheit");
    expect(temperatureUnitForLocale("es-PR")).toBe("fahrenheit");
    expect(temperatureUnitForLocale("fr-CA")).toBe("celsius");
    expect(temperatureUnitForLocale("ja-JP")).toBe("celsius");
  });

  it("falls back to Celsius rather than guessing", () => {
    expect(temperatureUnitForLocale("¯\\_(ツ)_/¯")).toBe("celsius");
    expect(temperatureUnitForLocale(undefined)).toBe("celsius");
    expect(temperatureUnitForLocale(null)).toBe("celsius");
    expect(temperatureUnitForLocale("en")).toBe("celsius");
  });
});

describe("temperatureUnitForLocales", () => {
  it("takes the first tag that actually names a region", () => {
    expect(temperatureUnitForLocales(["en", "en-GB"])).toBe("celsius");
    expect(temperatureUnitForLocales(["en", "en-US", "en-GB"])).toBe("fahrenheit");
    // A region-less or unparseable head does not veto the rest of the list.
    expect(temperatureUnitForLocales([undefined, "nonsense", "es-PR"])).toBe("fahrenheit");
  });

  it("stops at the first region, so preference order decides", () => {
    expect(temperatureUnitForLocales(["en-GB", "en-US"])).toBe("celsius");
    expect(temperatureUnitForLocales(["en-US", "en-GB"])).toBe("fahrenheit");
  });

  it("is Celsius when nothing names a region", () => {
    expect(temperatureUnitForLocales([])).toBe("celsius");
    expect(temperatureUnitForLocales(["en", "de", null, undefined])).toBe("celsius");
  });
});

describe("resolveTemperatureUnit", () => {
  it("resolves auto to what the browser was detected as", () => {
    expect(resolveTemperatureUnit("auto", "fahrenheit")).toBe("fahrenheit");
    expect(resolveTemperatureUnit("auto", "celsius")).toBe("celsius");
  });

  it("lets an explicit choice override detection", () => {
    expect(resolveTemperatureUnit("celsius", "fahrenheit")).toBe("celsius");
    expect(resolveTemperatureUnit("fahrenheit", "celsius")).toBe("fahrenheit");
  });
});

describe("parseTemperaturePreference", () => {
  it("accepts the three stored values and defaults everything else to auto", () => {
    expect(parseTemperaturePreference("auto")).toBe("auto");
    expect(parseTemperaturePreference("celsius")).toBe("celsius");
    expect(parseTemperaturePreference("fahrenheit")).toBe("fahrenheit");
    expect(parseTemperaturePreference("F")).toBe("auto");
    expect(parseTemperaturePreference("")).toBe("auto");
    expect(parseTemperaturePreference(null)).toBe("auto");
    expect(parseTemperaturePreference(undefined)).toBe("auto");
  });
});

describe("celsiusToFahrenheit", () => {
  it("converts without rounding — the caller rounds the label", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
    expect(celsiusToFahrenheit(64.4)).toBeCloseTo(147.92, 5);
  });
});
