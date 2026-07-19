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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  deleteAuthEntry,
  getOpStatus,
  pickOpReferenceSimple,
  readAuthJson,
  resolveShellValue,
  writeProviderAuthEntry,
} from "./index.js";
import { inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.js";

/**
 * The minimal context capability the onboarding surface needs: just `ui`.
 *
 * Typing to `Pick<ExtensionContext, "ui">` (rather than the whole
 * `ExtensionContext` or the narrower command-only context) keeps these
 * functions callable from **every** pi entry point that exposes `ctx.ui` —
 * command handlers, tool `execute()`, and event/shortcut handlers — and from a
 * bare `{ ui }` test double, without demanding the ~15 unrelated context members
 * they never touch. This is the least-coupled signature and it makes the ctx
 * path unit-testable.
 */
export type UiContext = Pick<ExtensionContext, "ui">;

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
 * Whether 1Password vault integration is usable: the `op` CLI is installed
 * **and** an auth path is **configured** — a service-account
 * token, 1Password Connect env, or a desktop/CLI account. It does **not** gate on
 * `op whoami`/`signedIn`, which reports a false "not signed in" for cold CLI
 * invocations under the desktop-app biometric integration even when `op read`
 * works. The check is passive: no unlock and no Touch ID prompt at check time;
 * the account session unlocks lazily on the first `op read`. Used to branch
 * onboarding between the vault picker and manual key entry.
 *
 * @returns `true` when `op` is available and configured, otherwise `false`.
 */
export async function is1PasswordAvailable(): Promise<boolean> {
  const status = await getOpStatus();
  return status.available && status.configured;
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

/** Verbatim cancel outcome used everywhere the user backs out. */
const CANCELLED: OnboardResult = { ok: false, message: "Onboarding cancelled." };

/**
 * Prompt for a literal API key on a **masked** screen — one bullet per typed
 * character, the value never drawn on screen. Shared by the
 * "Type or paste the key" source and the op-unavailable branch.
 */
async function promptMaskedKey(ctx: UiContext, label: string): Promise<string | undefined> {
  return inputInBorderedPopup(ctx, {
    title: `Enter your ${label} API key`,
    helpText: "Enter to save • Esc = cancel",
    mask: true,
  });
}

/**
 * Write the entry, then verify it resolves (post-save verify) and return
 * a friendly, human-only outcome message. Never surfaces `changeSecret`,
 * `auth.json`, or the raw `name` (except inside a `/{name}_onboard` command token).
 */
async function saveAndReport(
  opts: OnboardOptions,
  storedValue: string,
  overwrite: boolean,
  kind: "ref" | "literal",
  opAvailable: boolean,
): Promise<OnboardResult> {
  const res = await writeProviderAuthEntry(opts.name, storedValue, { overwrite });
  if (!res.success) {
    return { ok: false, message: `Couldn't save your ${opts.label} key. Please try again.` };
  }

  const verified = await verifySecret(opts.name);
  if (kind === "ref") {
    if (verified.ok) {
      return {
        ok: true,
        message: `${opts.label} is set up. Your key stays in 1Password and unlocks on demand.`,
      };
    }
    return {
      ok: true,
      message: `Saved. 1Password couldn't read it yet — unlock it, or check the reference.`,
    };
  }

  if (verified.ok) {
    return {
      ok: true,
      message: opAvailable
        ? `${opts.label} is set up. Your key is stored locally on this machine.`
        : `${opts.label} is set up, stored locally. Install 1Password CLI to use your vault.`,
    };
  }
  return {
    ok: true,
    message: `Saved, but the key looks empty — re-run onboarding to fix it.`,
  };
}

/**
 * Interactively onboard a secret.
 *
 * Order of operations:
 * 1. **Existing-key gate first** — if `name` already has a value and `overwrite`
 *    isn't set, offer *Replace it* / *Keep the current key*; keeping (or Esc)
 *    returns without touching anything.
 * 2. **Branch on {@link is1PasswordAvailable}:**
 *    - **available →** a source menu: *Locate in 1Password* (live vault → item →
 *      field browse, storing `!op read '<ref>'`), *Type or paste the key* (masked
 *      literal entry), or *Enter a 1Password reference* (validated `op://` path).
 *    - **not available →** straight to masked literal entry.
 * 3. **Write, then verify** the entry resolves and report a friendly outcome.
 *
 * No user-entered value or resolved secret is ever returned or logged; messages
 * never leak `auth.json`, `changeSecret`, or the raw `name` (outside a
 * `/{name}_onboard` token). Refuses to overwrite unless `opts.overwrite` (or
 * {@link changeSecret}) is used.
 *
 * @param ctx The extension context (drives the onboarding UI; works from command
 *   handlers, tool `execute()`, and a `{ ui }` double alike).
 * @param opts `{ name, label, overwrite? }`.
 * @returns `{ ok, message }` describing the outcome (never the secret).
 */
export async function onboardSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult> {
  let overwrite = opts.overwrite ?? false;

  // 1. Existing-key gate FIRST — before any source/browse work.
  if (!overwrite) {
    const parsed = await readAuthJson();
    if (parsed[opts.name] !== undefined) {
      const choice = await selectInBorderedPopup(ctx, {
        title: `${opts.label} is already set up`,
        items: [
          { value: "replace", label: "Replace it" },
          { value: "keep", label: "Keep the current key" },
        ],
        helpText: "↑↓ • Enter • Esc = keep current",
        maxVisible: 5,
      });
      if (choice !== "replace") {
        return { ok: false, message: `Kept your existing ${opts.label} key. Nothing changed.` };
      }
      overwrite = true;
    }
  }

  const opAvailable = await is1PasswordAvailable();

  // 2. Branch on 1Password availability.
  if (opAvailable) {
    const source = await selectInBorderedPopup(ctx, {
      title: `Set up your ${opts.label} key`,
      items: [
        {
          value: "browse",
          label: "Locate in 1Password",
          description: "Browse your vaults and select item",
        },
        {
          value: "paste",
          label: "Type or paste the key",
          description: "Manually insert your key",
        },
        {
          value: "ref",
          label: "Enter a 1Password reference",
          description: "Advanced: an op://vault/item/field path",
        },
        { value: "cancel", label: "Cancel" },
      ],
      helpText: "↑↓ • Enter • Esc = cancel",
      maxVisible: 6,
    });
    if (!source || source === "cancel") return CANCELLED;

    if (source === "browse") {
      // pickOpReferenceSimple owns its own one-voice error/empty notifications.
      const opRef = await pickOpReferenceSimple(ctx);
      if (!opRef) return CANCELLED;
      return saveAndReport(opts, `!op read '${opRef}'`, overwrite, "ref", true);
    }

    if (source === "paste") {
      const key = await promptMaskedKey(ctx, opts.label);
      if (!key) return CANCELLED;
      return saveAndReport(opts, key, overwrite, "literal", true);
    }

    // source === "ref" — an op:// path is a pointer, not a secret → plaintext input.
    const ref = await inputInBorderedPopup(ctx, {
      title: `1Password reference for ${opts.label}`,
      prompt: "Enter the op:// reference to your key's field.",
      defaultValue: "op://Vault/Item/field",
      helpText: "Format op://vault/item/field • Enter to confirm • Esc = cancel",
    });
    if (!ref) return CANCELLED;
    if (!/^op:\/\/[^/]+\/[^/]+\/[^/]+$/.test(ref)) {
      ctx.ui.notify("That doesn't look complete — use op://vault/item/field.", "warning");
      return CANCELLED;
    }
    return saveAndReport(opts, `!op read '${ref}'`, overwrite, "ref", true);
  }

  // Branch B — 1Password not available → straight to masked literal entry.
  const key = await promptMaskedKey(ctx, opts.label);
  if (!key) return CANCELLED;
  return saveAndReport(opts, key, overwrite, "literal", false);
}

/**
 * Change an existing secret: {@link onboardSecret} with `overwrite: true`. Runs the
 * same availability-branched flow and replaces any current entry for `opts.name`.
 *
 * @param ctx The extension context.
 * @param opts `{ name, label }` (overwrite is forced on).
 * @returns `{ ok, message }`.
 */
export async function changeSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult> {
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
