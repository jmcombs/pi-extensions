/**
 * @jmcombs/pi-1password — stateless, importable credential API.
 *
 * This module is the public credential surface of the 1Password extension. Other
 * pi extensions declare `@jmcombs/pi-1password` as a hard dependency (D2) and
 * import these functions instead of touching pi internals (`AuthStorage`,
 * `ModelRuntime`, `readStoredCredential` — all removed in pi 0.80.8).
 *
 * Every function is **stateless** (D3): it reads `~/.pi/agent/auth.json` and/or
 * runs the `op` CLI fresh on each call and relies on no module-level session
 * state, so a consumer that imports a fresh module instance behaves identically
 * to the host extension.
 *
 * Storage shape (D4): entries are provider-shaped and keyed by logical name —
 * `{"context7": {"type":"api_key","key":"!op read 'op://Vault/Item/field'"}}` for
 * a 1Password reference, or `{"context7": {"type":"api_key","key":"<literal>"}}`
 * for a manually entered key. Legacy bare-string entries
 * (`{"context7": "!op read '…'"}`) still resolve on read.
 *
 * See docs/1p-credential-api/API.md for the full reference.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  deleteAuthEntry,
  getOpStatus,
  pickOpReferenceSimple,
  readAuthJson,
  resolveShellValue,
  writeProviderAuthEntry,
} from "./index.js";
import { inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.js";

/** Options accepted by {@link onboardSecret} / {@link changeSecret}. */
export interface OnboardOptions {
  /** Logical name the secret is stored and resolved under (e.g. `"context7"`). */
  readonly name: string;
  /** Human-readable label shown in onboarding prompts (e.g. `"Context7"`). */
  readonly label: string;
  /** When true, overwrite an existing entry instead of failing. */
  readonly overwrite?: boolean;
}

/** Result of an onboarding / change operation. Never contains the secret value. */
export interface OnboardResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Result of {@link verifySecret}. Never contains the secret value. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly resolved: boolean;
  readonly error?: string;
}

/** Result of {@link deleteSecret}. */
export interface DeleteResult {
  readonly ok: boolean;
}

/**
 * Whether 1Password vault integration is usable right now: the `op` CLI is
 * installed **and** an account session is signed in (D6). Runs `op --version` +
 * `op whoami` fresh. Used to branch onboarding between the vault picker and
 * manual key entry.
 *
 * @returns `true` when `op` is available and signed in, otherwise `false`.
 */
export async function is1PasswordAvailable(): Promise<boolean> {
  const status = await getOpStatus();
  return status.available && status.signedIn;
}

/**
 * Resolve a stored secret to its concrete value (D5). Reads `auth.json` fresh,
 * takes `parsed[name]`, and resolves it via the shared `!op read` / shell / literal
 * resolver — handling **both** a provider-shaped object (`.key`) and a bare literal
 * string. Fails closed: returns `undefined` when the entry is missing or `op read`
 * fails, never the unresolved raw value.
 *
 * @param name Logical name to resolve (e.g. `"context7"`).
 * @returns The resolved secret, or `undefined` if it cannot be resolved.
 */
export async function resolveSecret(name: string): Promise<string | undefined> {
  const parsed = await readAuthJson();
  const entry = parsed[name];
  const resolved = await resolveShellValue(
    typeof entry === "string" ? entry : (entry as { key?: unknown } | undefined)?.key,
  );
  return resolved ?? undefined;
}

/**
 * Interactively onboard a secret, branching on 1Password availability (D6).
 *
 * - **`op` available and signed in →** prompt for a 1Password reference (live vault
 *   → item → field picker, or a manually typed `op://…`), then store it as a
 *   `!op read '<ref>'` entry (provider-shaped, D4).
 * - **`op` not available →** prompt for the literal API key, store it as a literal
 *   provider-shaped entry, and nudge the user to install/enable the 1Password
 *   extension to unlock vault integration and the startup unlock.
 *
 * No user-entered value or resolved secret is ever returned or logged. Refuses to
 * overwrite an existing entry unless `opts.overwrite` (or {@link changeSecret}) is
 * used.
 *
 * @param ctx The extension command context (drives the onboarding UI).
 * @param opts `{ name, label, overwrite? }`.
 * @returns `{ ok, message }` describing the outcome (never the secret).
 */
export async function onboardSecret(
  ctx: ExtensionCommandContext,
  opts: OnboardOptions,
): Promise<OnboardResult> {
  const overwrite = opts.overwrite ?? false;

  if (await is1PasswordAvailable()) {
    const method = await selectInBorderedPopup(ctx, {
      title: `Add "${opts.label}" via 1Password`,
      items: [
        { value: "lookup", label: "Look it up in 1Password (vault → item → field)" },
        { value: "manual", label: "Type the op:// reference manually" },
        { value: "cancel", label: "Cancel" },
      ],
      helpText: "↑↓ • Enter • Esc = cancel",
      maxVisible: 5,
    });
    if (!method || method === "cancel") {
      return { ok: false, message: "Onboarding cancelled." };
    }

    let opRef: string | null = null;
    if (method === "lookup") {
      opRef = await pickOpReferenceSimple(ctx);
    } else {
      const manual = await inputInBorderedPopup(ctx, {
        title: `${opts.label} — op:// reference`,
        prompt: "Enter the full 1Password secret reference.",
        defaultValue: "op://Vault/Item/field",
        helpText: "Must start with op:// • Enter to confirm • Esc = cancel",
      });
      opRef = manual?.startsWith("op://") ? manual : null;
    }
    if (!opRef) {
      return { ok: false, message: "Onboarding cancelled — no 1Password reference provided." };
    }

    const res = await writeProviderAuthEntry(opts.name, `!op read '${opRef}'`, { overwrite });
    if (!res.success) {
      return { ok: false, message: res.message };
    }
    return {
      ok: true,
      message: `Saved "${opts.name}" as a 1Password reference. It resolves fresh via \`op read\` on each use.`,
    };
  }

  // 1Password unavailable → manual literal API-key entry + install nudge.
  const key = await inputInBorderedPopup(ctx, {
    title: `${opts.label} — API key`,
    prompt: `Paste your ${opts.label} API key. It is stored locally in auth.json (0600) and never shown to the model.`,
    helpText: "Enter to confirm • Esc = cancel",
  });
  if (!key) {
    return { ok: false, message: "Onboarding cancelled." };
  }

  const res = await writeProviderAuthEntry(opts.name, key, { overwrite });
  if (!res.success) {
    return { ok: false, message: res.message };
  }
  return {
    ok: true,
    message: `Saved "${opts.name}" as a local API key. Install and sign in to the 1Password extension (\`op\`) to unlock vault references and the startup unlock.`,
  };
}

/**
 * Change an existing secret: {@link onboardSecret} with `overwrite: true`. Runs the
 * same availability-branched flow and replaces any current entry for `opts.name`.
 *
 * @param ctx The extension command context.
 * @param opts `{ name, label }` (overwrite is forced on).
 * @returns `{ ok, message }`.
 */
export async function changeSecret(
  ctx: ExtensionCommandContext,
  opts: OnboardOptions,
): Promise<OnboardResult> {
  return onboardSecret(ctx, { ...opts, overwrite: true });
}

/**
 * Verify that a stored secret resolves to a non-empty value **without returning the
 * value**. Useful for onboarding confirmation and diagnostics.
 *
 * @param name Logical name to verify.
 * @returns `{ ok, resolved, error? }` — `ok`/`resolved` are `true` only when
 *   `resolveSecret` yields a non-empty value; `error` explains a failure.
 */
export async function verifySecret(name: string): Promise<VerifyResult> {
  try {
    const resolved = await resolveSecret(name);
    if (typeof resolved === "string" && resolved.length > 0) {
      return { ok: true, resolved: true };
    }
    return {
      ok: false,
      resolved: false,
      error: `No value resolved for "${name}" (missing entry, or \`op read\` failed / returned empty).`,
    };
  } catch (e) {
    return { ok: false, resolved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Delete a stored secret, removing `parsed[name]` from `auth.json` under the file
 * lock (D4 concurrency).
 *
 * @param name Logical name to remove.
 * @returns `{ ok }` — `true` when an entry was present and removed, `false` when
 *   there was nothing to remove.
 */
export async function deleteSecret(name: string): Promise<DeleteResult> {
  return deleteAuthEntry(name);
}
