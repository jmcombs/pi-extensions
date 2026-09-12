/**
 * drivers/thinking.ts — Pi thinking levels as they arrive at a relay driver.
 *
 * Pi encodes thinking two ways that both show up at this seam:
 *   1. `options.reasoning` on `streamSimple` (`minimal`…`max`; omitted when off)
 *   2. a `:<level>` suffix on the model id (`opus:high`, `relay-cursor/opus:off`)
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

/** A leading `<provider>/` segment, e.g. the `relay-cursor/` in `relay-cursor/opus`. */
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
 * Strips a `provider/` prefix first (`relay-cursor/opus:high` → `opus` + `high`).
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
