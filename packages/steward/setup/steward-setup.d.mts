/**
 * Types for the one helper the parity test imports directly.
 *
 * The script itself stays plain `.mjs` with only `node:` imports, so it runs on
 * the oldest Node this package supports — older than default TypeScript
 * stripping. That is why the drift comparison is duplicated there rather than
 * imported from `core/drift.ts`, and why the parity test exists.
 */

export type RecordedArgvDiff =
  | { status: "clean"; added: string[]; removed: string[]; program: string | null }
  | { status: "drifted"; added: string[]; removed: string[]; program: string | null }
  | { status: "unknown"; reason: string };

/** Compares a recorded argv against a live `ps` line, as `core/drift.ts` does. */
export function diffRecordedArgv(recorded: readonly string[], observed: string): RecordedArgvDiff;
