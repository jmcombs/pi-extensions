/**
 * Turns a `llama-server` `/props` body into the CONFIG rows the rail shows.
 *
 * `/props` arrives as `unknown` off the wire, so every field is validated before
 * it is read — a missing or wrong-typed field renders as an em dash, never as
 * `undefined` or `NaN`. Two server shapes are handled: the routed server Pi runs
 * by default (`role: "router"`, with a model cap and an autoload flag), and a
 * bare single-model server (`-m model.gguf`), which reports neither. Only the
 * router shape is exercised against a live server; the single-model branch is
 * built from llama.cpp's documented shape and unit-tested with a hand-authored
 * fixture.
 *
 * This is a pure function so it can be tested directly against the captured real
 * `/props` fixtures. Keep it free of Node and DOM APIs.
 */

import { listenAddress } from "./llama-connection.js";
import type { ConfigEntry } from "./types.js";

/** Shown wherever a value is absent or the wrong type. */
const MISSING = "—";

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A non-empty string field, or `null` when absent/blank/wrong-typed. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A finite-number field rendered as text, or the em dash when absent. */
function readCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : MISSING;
}

/** A boolean flag as `on`/`off`, or the em dash when it is neither. */
function readToggle(value: unknown): string {
  if (value === true) return "on";
  if (value === false) return "off";
  return MISSING;
}

/**
 * The CONFIG rows for a `/props` body read from `baseUrl`. `listen` is derived
 * from the connection, not the body, so it is present even when the body is
 * empty. Router-only rows (`max models`, `autoload`) are emitted only in routed
 * mode; a single-model server omits them rather than showing blanks.
 */
export function parseRouterConfig(props: unknown, baseUrl: string): ConfigEntry[] {
  const record = isRecord(props) ? props : {};
  const listen = listenAddress(baseUrl);
  const build = readString(record.build_info);
  const binary = build !== null ? `llama-server ${build}` : MISSING;

  if (record.role === "router") {
    return [
      { key: "mode", value: "routed" },
      { key: "engine", value: binary },
      { key: "address", value: listen },
      { key: "max models", value: readCount(record.max_instances) },
      { key: "autoload", value: readToggle(record.models_autoload) },
    ];
  }

  return [
    { key: "mode", value: "single model" },
    { key: "engine", value: binary },
    { key: "address", value: listen },
  ];
}
