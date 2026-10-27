/**
 * drivers/thinking.ts — Pi thinking levels as they arrive at a relay driver.
 *
 * Pi encodes thinking two ways that both show up at this seam:
 *   1. `options.reasoning` on `streamSimple` (`minimal`…`max`; omitted when off)
 *   2. a `:<level>` suffix on the model id (`opus-5-5:high`, `relay-cursor/claude-opus-5-5:off`)
 *
 * Mapping a resolved level onto a backend flag or listed `--model` id is a
 * per-driver concern (D10). This module only parses Pi's own encoding.
 */

/** Pi thinking levels, including `off` (absent from `options.reasoning`). */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PI_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** A leading `<provider>/` segment, e.g. the `relay-cursor/` in `relay-cursor/claude-opus-5-5`. */
const PROVIDER_PREFIX = /^[^/]*\//;

/** A pi thinking level appended to the model id, e.g. the `:high` in `opus:high`. */
const PI_THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

export interface ParsedModelId {
  /** Model id with provider prefix and thinking suffix removed, lowercased. */
  readonly bareId: string;
  /** Thinking suffix, if the model id carried one. */
  readonly thinking?: PiThinkingLevel;
}

function asThinkingLevel(value: string): PiThinkingLevel | undefined {
  return PI_THINKING_LEVELS.has(value) ? (value as PiThinkingLevel) : undefined;
}

/**
 * Split a pi model id into the bare backend id and an optional thinking suffix.
 * Strips a `provider/` prefix first (`relay-cursor/claude-opus-5-5:high` → `opus-5-5` + `high`).
 */
export function parseModelThinking(modelId: string): ParsedModelId {
  const stripped = modelId.trim().toLowerCase().replace(PROVIDER_PREFIX, "");
  const match = PI_THINKING_SUFFIX.exec(stripped);
  if (!match) return { bareId: stripped };
  return {
    bareId: stripped.replace(PI_THINKING_SUFFIX, ""),
    thinking: match[1] as PiThinkingLevel,
  };
}

/**
 * Resolve the Pi thinking level for a relayed run.
 *
 * `options.reasoning` (the live session / role thinking control) wins over a
 * `:<level>` suffix on the model id. Either source may be absent: a missing
 * value means Pi did not request a level (treat as off at the driver).
 */
export function resolveThinkingLevel(
  modelId: string,
  optionsReasoning?: string,
): PiThinkingLevel | undefined {
  const fromOptions =
    optionsReasoning !== undefined ? asThinkingLevel(optionsReasoning) : undefined;
  if (fromOptions !== undefined) return fromOptions;
  return parseModelThinking(modelId).thinking;
}

const PI_THINKING_ORDER: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Pi thinking-level map for a model. A supported level's provider value is the
 * Pi level itself (the driver applies that level). `null` hides a level Pi
 * cannot drive on this model.
 */
export function piThinkingMap(
  supported: readonly PiThinkingLevel[],
): Record<PiThinkingLevel, string | null> {
  const allowed = new Set<PiThinkingLevel>(supported);
  return {
    off: allowed.has("off") ? "off" : null,
    minimal: allowed.has("minimal") ? "minimal" : null,
    low: allowed.has("low") ? "low" : null,
    medium: allowed.has("medium") ? "medium" : null,
    high: allowed.has("high") ? "high" : null,
    xhigh: allowed.has("xhigh") ? "xhigh" : null,
    max: allowed.has("max") ? "max" : null,
  };
}

/**
 * Clamp a requested Pi level onto one this model can express.
 *
 * Matches Pi's `clampThinkingLevel`: an unsupported level walks upward, then
 * downward. A missing request is Pi `off` (`options.reasoning` is omitted when
 * the session thinking level is off).
 */
export function clampToSupported(
  level: PiThinkingLevel | undefined,
  supported: readonly PiThinkingLevel[],
): PiThinkingLevel {
  const requested = level ?? "off";
  if (supported.includes(requested)) return requested;
  const requestedIndex = PI_THINKING_ORDER.indexOf(requested);
  if (requestedIndex === -1) return supported[0] ?? "off";
  for (let i = requestedIndex + 1; i < PI_THINKING_ORDER.length; i++) {
    const candidate = PI_THINKING_ORDER[i];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = PI_THINKING_ORDER[i];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? "off";
}
