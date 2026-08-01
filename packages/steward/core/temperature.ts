/**
 * Which unit temperatures are *displayed* in, and how that is decided.
 *
 * Only the DISPLAYED STRING ever changes unit. Every threshold, comparison and
 * bar scale in `./format.ts` is Celsius and stays Celsius — converting a reading
 * before comparing it would turn a 79 °C warning into a 174 °F reading against a
 * 75 threshold and paint every gauge critical. So the unit travels as far as
 * `formatTemperature` and no further.
 *
 * The unit is derived from the operator's REGION, not from a temperature API:
 * `Intl.Locale.prototype.getTemperatureUnit()` and the `measurementSystem`
 * proposal are not standard, are absent in the browsers this dashboard runs in,
 * and would silently answer "metric" for everyone. A region is a fact every
 * browser reports.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`. `Intl` is
 * neither: it is part of the language, present in both projects, and every call
 * here is guarded, so a runtime that lacks it degrades to Celsius rather than
 * throwing.
 */

/** The unit a temperature is rendered in. There is no third option. */
export type TemperatureUnit = "celsius" | "fahrenheit";

/**
 * The operator's stored choice. `auto` — the default — means "follow the
 * browser", and is resolved to a {@link TemperatureUnit} at apply time by
 * {@link resolveTemperatureUnit}; the other two pin the unit regardless of
 * locale.
 *
 * Modelled now, with no control to set it: the preference is what a later
 * override toggle would store, and having the shape settled means adding that
 * control is a control, not a migration.
 */
export type TemperaturePreference = "auto" | TemperatureUnit;

/**
 * The regions that read temperatures in Fahrenheit: the three countries that
 * use it officially (the United States, Liberia and Myanmar), the five inhabited
 * US territories, and the handful of Caribbean and Pacific states whose everyday
 * weather reporting follows the US.
 *
 * Everything not in this set is Celsius. That asymmetry is deliberate — the
 * default has to be the one that is right for the overwhelming majority of the
 * world's regions, so an unrecognised region is Celsius rather than a guess.
 */
export const FAHRENHEIT_REGIONS: ReadonlySet<string> = new Set([
  "US", // United States
  "LR", // Liberia
  "MM", // Myanmar
  "PR", // Puerto Rico
  "GU", // Guam
  "VI", // US Virgin Islands
  "AS", // American Samoa
  "MP", // Northern Mariana Islands
  "PW", // Palau
  "FM", // Micronesia
  "MH", // Marshall Islands
  "KY", // Cayman Islands
  "BS", // Bahamas
  "BZ", // Belize
]);

/**
 * A BCP-47 tag's region subtag, upper-cased, or `null` when the tag carries
 * none or is not a tag at all.
 *
 * `Intl.Locale` does the parsing where it exists, because it also canonicalises
 * (`en-us` → `US`) and understands the tag forms a regex would have to enumerate.
 * It THROWS on a malformed tag, so the call is guarded and a hand-rolled match on
 * the region subtag stands in for a runtime without it. Either way this function
 * cannot throw: an unparseable or absent tag is `null`, which reads as Celsius.
 *
 * The tag is deliberately NOT maximised. `en` alone stays region-less rather
 * than being expanded to `en-Latn-US`: a language with no region attached is not
 * evidence of a country, and inventing one would hand `en` to Fahrenheit on the
 * strength of CLDR's likely-subtags table.
 */
export function regionFromLocale(locale: string | null | undefined): string | null {
  if (typeof locale !== "string" || locale.trim() === "") return null;
  try {
    const region = new Intl.Locale(locale).region;
    if (typeof region === "string" && region !== "") return region.toUpperCase();
    return null;
  } catch {
    // Malformed for `Intl.Locale`, or no `Intl.Locale` at all: fall through to
    // the subtag match, which is the same rule with none of the canonicalising.
  }
  const match = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2}|\d{3})(?:-|$)/.exec(locale.trim());
  return match?.[1] === undefined ? null : match[1].toUpperCase();
}

/** The unit a region reads temperatures in. An unknown region is Celsius. */
export function unitForRegion(region: string | null | undefined): TemperatureUnit {
  if (typeof region !== "string") return "celsius";
  return FAHRENHEIT_REGIONS.has(region.toUpperCase()) ? "fahrenheit" : "celsius";
}

/**
 * The unit one browser locale implies — `en-US` → Fahrenheit, `en-GB`, `de-DE`
 * and a tag with no region at all → Celsius.
 */
export function temperatureUnitForLocale(locale: string | null | undefined): TemperatureUnit {
  return unitForRegion(regionFromLocale(locale));
}

/**
 * The unit implied by a browser's locale list, in preference order.
 *
 * The FIRST tag that names a region decides, so a `["en", "en-GB"]` browser
 * reads `GB` instead of stopping at a region-less `en` and defaulting. A list
 * with no region anywhere in it is Celsius.
 */
export function temperatureUnitForLocales(
  locales: readonly (string | null | undefined)[],
): TemperatureUnit {
  for (const locale of locales) {
    const region = regionFromLocale(locale);
    if (region !== null) return unitForRegion(region);
  }
  return "celsius";
}

/**
 * The preference applied: `auto` becomes whatever the browser was detected as,
 * and an explicit choice wins over detection.
 */
export function resolveTemperatureUnit(
  preference: TemperaturePreference,
  detected: TemperatureUnit,
): TemperatureUnit {
  return preference === "auto" ? detected : preference;
}

/** A stored preference, or `auto` for anything that is not one of the three. */
export function parseTemperaturePreference(
  value: string | null | undefined,
): TemperaturePreference {
  return value === "celsius" || value === "fahrenheit" || value === "auto" ? value : "auto";
}

/**
 * Celsius to Fahrenheit. Exported so the conversion is stated once and asserted
 * on directly; note that rounding happens AFTER this, in `formatTemperature`,
 * so a 64.4 °C reading rounds from 147.92 °F rather than from a pre-rounded 64.
 */
export function celsiusToFahrenheit(celsius: number): number {
  return celsius * (9 / 5) + 32;
}
