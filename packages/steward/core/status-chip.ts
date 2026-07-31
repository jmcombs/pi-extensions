/**
 * The text Steward puts on Pi's footer.
 *
 * Pi renders extension statuses on their own line, sorted by key and joined with
 * a space, then truncates the joined line from the right. So this string shares
 * space with other extensions' chips, and its own tail is what gets cut first —
 * clause order below is deliberate: subject, state, then detail.
 *
 * `setStatus` takes plain text and nothing else. There is no colour, no style,
 * and no width to measure against, so the state has to be carried by the words.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import type { Snapshot } from "./types.js";

/**
 * The default mark: Nerd Font `nf-md-room-service-outline`, which matches the
 * stroked cloche of Steward's logo — a thin arc over rounded bars. A Nerd Font
 * is a documented requirement, so this renders for every supported install;
 * `STEWARD_GLYPH` replaces it for an operator who has patched their own mark
 * into their font, and an empty value drops it entirely.
 */
export const DEFAULT_GLYPH = "\u{F1056}";

/** Separates the name from the state, matching the logo's own spare style. */
const SEPARATOR = "›";

/** Resolves the mark, honouring an operator override. */
export function resolveGlyph(env: Record<string, string | undefined>): string {
  const override = env.STEWARD_GLYPH;
  if (override === undefined) return DEFAULT_GLYPH;
  return override.trim();
}

/**
 * The chip for a snapshot, or for no snapshot at all.
 *
 * `null` means Steward has not read the machine yet — distinct from having read
 * it and found nothing, which is what a disconnected snapshot says.
 */
export function statusChip(snapshot: Snapshot | null, glyph: string): string {
  const mark = glyph === "" ? "" : `${glyph} `;
  const head = `${mark}Steward ${SEPARATOR} `;

  if (snapshot === null) return `${head}checking…`;

  // No config means Steward was never pointed at anything. Saying "stopped"
  // about a machine it has never looked at would be a claim, not a reading —
  // and on a machine whose llama-server is running perfectly, a wrong one.
  if (snapshot.drift.launch.status === "unknown" && snapshot.service.port === 0) {
    return `${head}not connected · /initialize-steward`;
  }

  if (!snapshot.service.running) return `${head}stopped`;

  // Loaded is a count Steward can stand behind: it comes from the router's own
  // catalogue. An empty catalogue is different from a catalogue of unloaded
  // models, and both are different from not having read one.
  //
  // "Resident" is the honest test, and it is two states: `active` is serving a
  // request right now, `resident` is loaded and idle. Both hold weights in
  // memory, which is what the operator is counting.
  const loaded = snapshot.models.filter(
    (model) => model.status === "active" || model.status === "resident",
  ).length;
  const detail =
    snapshot.models.length === 0 ? "no models" : loaded === 0 ? "none loaded" : `${loaded} loaded`;
  return `${head}running · ${detail}`;
}
