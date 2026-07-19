/**
 * @jmcombs/pi-1password — 1Password integration for the Pi coding agent.
 *
 * Provides tools to read secrets from 1Password and run commands with
 * 1Password credential injection using the `op` CLI.
 *
 * This is especially useful when 1Password shell plugins (e.g. `alias gh="op plugin run -- gh"`)
 * do not work inside Pi's non-interactive bash tool.
 *
 * See:
 *   - CONTRIBUTING.md (project conventions)
 *   - TEMPLATE.md at the repo root
 *   - https://pi.dev/docs/extensions
 */

import { exec } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// `createLocalBashOperations` is NOT on oh-my-pi's shim. Accessing it through a
// namespace import makes a missing member `undefined` at runtime rather than a
// hard ESM link error that would take this whole module (and every consumer that
// imports it, e.g. via `resolveSecret`/`onboardSecret`) down on that runtime.
import * as piRuntime from "@earendil-works/pi-coding-agent";
// `createBashTool` + `getAgentDir` are always present on the pi runtime (and on
// oh-my-pi's legacy-pi compat shim), so they stay as static named imports.
import { createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { UiContext } from "./credential-api.js";
import {
  confirmInBorderedPopup,
  inputInBorderedPopup,
  selectInBorderedPopup,
} from "./ui/bordered-popups.js";

// ── Public stateless credential API (D1/D3) ────────────────────────────
// The 1Password extension is the credential authority: consumer extensions
// import these from "@jmcombs/pi-1password" and never touch pi internals.
// See docs/1p-credential-api/API.md.
export {
  changeSecret,
  deleteSecret,
  is1PasswordAvailable,
  onboardSecret,
  resolveSecret,
  verifySecret,
} from "./credential-api.js";

const execAsync = promisify(exec);

// ── Internal helpers for diagnostics (properly typed) ──────────────────

interface OpStatus {
  available: boolean;
  version: string | null;
  /**
   * DIAGNOSTIC ONLY. Whether `op whoami` reports a live CLI session. Under the
   * 1Password desktop-app biometric integration this is `false` for a cold
   * invocation even when `op read` works — so it MUST NOT gate availability.
   * Surfaced in diagnostics; never used for access decisions.
   */
  signedIn: boolean;
  /**
   * Whether an `op` auth path is CONFIGURED (service-account token, Connect env,
   * or a desktop/CLI account). This — not `signedIn` — is what gates availability.
   * Determined passively: no unlock, no Touch ID prompt.
   */
  configured: boolean;
  account: Record<string, unknown> | null;
}

interface PluginInspection {
  plugin: string;
  output?: string;
  error?: string;
}

interface CuratedPlugin {
  name: string;
  slug: string;
  envVars: string[];
  primaryEnvVar: string | null;
  pageUrl: string;
}

// Minimal shapes for `op` JSON responses (used by diagnostics + onboarding pickers).
interface OpVault {
  name: string;
}
interface OpItem {
  id: string;
  title: string;
  category?: string;
}
interface OpField {
  label: string;
  type?: string;
}

/**
 * Whether an `op` auth path is CONFIGURED, checked passively (no unlock, no Touch
 * ID). True when any of: `OP_SERVICE_ACCOUNT_TOKEN` is set; both `OP_CONNECT_HOST`
 * and `OP_CONNECT_TOKEN` are set; or `op account list --format=json` exits 0 and
 * parses to a non-empty array. Any failure/timeout/unparsable output ⇒ `false`;
 * never throws. Never logs secret values.
 */
async function isOpConfigured(): Promise<boolean> {
  if ((process.env.OP_SERVICE_ACCOUNT_TOKEN ?? "").length > 0) return true;
  if (
    (process.env.OP_CONNECT_HOST ?? "").length > 0 &&
    (process.env.OP_CONNECT_TOKEN ?? "").length > 0
  ) {
    return true;
  }
  try {
    const { stdout } = await execAsync("op account list --format=json", {
      encoding: "utf8",
      timeout: 5000,
    });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // Non-zero exit, timeout, or unparsable output → treat as not configured.
    return false;
  }
}

/**
 * Probe the `op` CLI. Runs `op --version` (→ `available`), `op whoami` (→
 * `signedIn`, DIAGNOSTIC ONLY — see below), and {@link isOpConfigured} (→
 * `configured`) fresh on every call. Reused by {@link is1PasswordAvailable}.
 *
 * `signedIn` from `op whoami` is unreliable for gating: under the 1Password
 * desktop-app biometric integration it returns non-zero for a cold CLI invocation
 * even when `op read` works. Availability therefore gates on `configured`, not
 * `signedIn`; the account session is unlocked lazily on the first
 * `op read`. All `op` probes use a 5s timeout and never throw.
 */
export async function getOpStatus(): Promise<OpStatus> {
  let version: string | null = null;
  try {
    const { stdout } = await execAsync("op --version", { encoding: "utf8", timeout: 5000 });
    version = stdout.trim();
  } catch {
    return { available: false, version: null, signedIn: false, configured: false, account: null };
  }

  // signedIn — DIAGNOSTIC ONLY (see the OpStatus.signedIn doc). A
  // non-zero `op whoami` is expected under app-integration and is NOT a gate.
  let signedIn = false;
  let account: Record<string, unknown> | null = null;
  try {
    const { stdout: whoamiOut } = await execAsync("op whoami --format json", {
      encoding: "utf8",
      timeout: 5000,
    });
    account = JSON.parse(whoamiOut) as Record<string, unknown>;
    signedIn = true;
  } catch {
    signedIn = false;
    account = null;
  }

  const configured = await isOpConfigured();

  return { available: true, version, signedIn, configured, account };
}

async function inspectPluginIfRelevant(command: string): Promise<PluginInspection | null> {
  const firstWord = command.trim().split(/\s+/)[0] ?? "";
  const knownPlugins = [
    "gh",
    "aws",
    "heroku",
    "npm",
    "pip",
    "docker",
    "doctl",
    "fly",
    "netlify",
    "vercel",
    "stripe",
    "sentry",
  ];

  if (!knownPlugins.includes(firstWord)) {
    return null;
  }

  try {
    const { stdout } = await execAsync(`op plugin inspect ${firstWord}`, {
      encoding: "utf8",
      timeout: 8000,
    });

    return { plugin: firstWord, output: (stdout || "").trim() };
  } catch (e: unknown) {
    const error = e as { stderr?: string; message?: string };
    const msg = (error.stderr?.trim() ?? error.message) || "Unknown error";
    return { plugin: firstWord, error: msg };
  }
}

function formatOpStatus(status: OpStatus): string {
  if (!status.available) {
    return "1Password CLI (`op`) is not available in PATH.";
  }
  if (!status.configured) {
    return `op ${status.version ?? "unknown"} is installed but no 1Password account is configured. Run 'op signin', or set OP_SERVICE_ACCOUNT_TOKEN (or OP_CONNECT_HOST + OP_CONNECT_TOKEN).`;
  }
  const acct = status.account ?? {};
  const name =
    (acct.name as string | undefined) ??
    (acct.email as string | undefined) ??
    (acct.account_uuid as string | undefined) ??
    null;
  const url = (acct.url as string | undefined) ?? null;
  if (status.signedIn && name) {
    return `op ${status.version ?? "unknown"} — signed in as ${name}${url ? ` (${url})` : ""}`;
  }
  // Configured but no live CLI session (typical under the desktop-app biometric
  // integration) — the account session unlocks on the first `op read`.
  return `op ${status.version ?? "unknown"} — 1Password account configured (session unlocks on first use).`;
}

// ── Shell env loading from ~/.pi/agent/auth.json (top-level keys per user choice A) ──

type AuthJson = Record<string, unknown>;

const KNOWN_PROVIDER_KEYS = new Set([
  "anthropic",
  "openai",
  "azure-openai-responses",
  "deepseek",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

/**
 * Resolve a single stored auth value to its concrete secret. A `!op read '<ref>'`
 * value runs the 1Password CLI; any other `!<cmd>` runs in a minimal shell; a bare
 * literal is returned as-is. Fails closed (returns `null`) on any error. Reused by
 * {@link resolveSecret} and {@link warmOpSessionIfNeeded}.
 */
export async function resolveShellValue(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();

  if (trimmed.startsWith("!op read ")) {
    const ref = trimmed.replace(/^!op read\s+/, "").replace(/^['"]|['"]$/g, "");
    try {
      const { stdout } = await execAsync(`op read "${ref}"`, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });

      return (stdout || "").trim();
    } catch {
      return null; // fail closed for this key
    }
  }

  if (trimmed.startsWith("!")) {
    // Generic shell command (e.g. !security find-generic-password ...)
    // Execute in a minimal non-interactive shell for safety
    try {
      const cmd = trimmed.slice(1).trim();
      const { stdout } = await execAsync(cmd, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15000,
        shell: "/bin/sh",
      });

      return (stdout || "").trim();
    } catch {
      return null;
    }
  }

  // Literal value or env-var name indirection — treat literal as-is for now
  // (If it is exactly an env var name with no value, caller can decide to pull process.env)
  if (trimmed) return trimmed;
  return null;
}

async function loadShellEnvMap(): Promise<Record<string, string>> {
  const home = homedir() || "/tmp";
  const authPath = join(home, ".pi", "agent", "auth.json");
  const map = new Map<string, string>();

  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as AuthJson;

    for (const [key, val] of Object.entries(parsed)) {
      if (KNOWN_PROVIDER_KEYS.has(key)) continue; // don't leak LLM keys by default
      if (typeof key !== "string" || !/^[A-Z0-9_]+$/.exec(key)) continue; // only plausible env var names

      const resolved = await resolveShellValue(val);
      if (resolved !== null) {
        map.set(key, resolved);
      }
    }
  } catch {
    // File missing or unreadable — no shell env injection this session
  }

  return Object.fromEntries(map);
}

// In-memory map for the current session (populated on session_start)
let currentShellEnv: Record<string, string> = {};

// Curated shell plugin list (loaded once at startup for /1password_setup suggestions)
let curatedPlugins: CuratedPlugin[] = [];

/** Returns the *names* of currently injected shell env vars (never the values). Safe for diagnostics / LLM. */
export function getShellEnvNames(): string[] {
  return Object.keys(currentShellEnv);
}

// ── Curated list + auth.json writer (for /1password_setup) ────────────

/** Load the maintained list of 1P shell plugins (generated by scripts/update-1p-shell-plugins.ts). */
async function loadCuratedPlugins(): Promise<CuratedPlugin[]> {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirnameLocal = dirname(__filename);
    const dataPath = join(__dirnameLocal, "data", "shell-plugins.json");
    const raw = await readFile(dataPath, "utf8");
    return JSON.parse(raw) as CuratedPlugin[];
  } catch {
    // Non-fatal: onboarding still works for custom entries; curated suggestions just won't be available.
    return [];
  }
}

/**
 * Safely add (or overwrite) a top-level KEY: "!op read 'op://...'" entry
 * to the agent's auth.json using Pi's recommended agent directory.
 * Uses 0600 permissions. Supports optional overwrite.
 */
async function addAuthEntry(
  envVar: string,
  opRef: string,
  options: { overwrite?: boolean } = {},
): Promise<{ success: boolean; message: string; path: string }> {
  const authDir = getAgentDir();
  const authPath = join(authDir, "auth.json");

  await mkdir(authDir, { recursive: true });

  const existing = new Map<string, unknown>();
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        existing.set(k, v);
      }
    }
  } catch {
    // File missing or invalid JSON → start fresh
  }

  const alreadyExists = existing.has(envVar);

  if (alreadyExists && !options.overwrite) {
    return {
      success: false,
      message: `Key "${envVar}" already exists in auth.json. Pick a different env var name or remove the old entry first.`,
      path: authPath,
    };
  }

  // Convention: single quotes around the op:// ref
  existing.set(envVar, `!op read '${opRef}'`);

  const content = `${JSON.stringify(Object.fromEntries(existing), null, 2)}\n`;
  await writeFile(authPath, content, "utf8");
  await chmod(authPath, 0o600);

  return { success: true, message: "Entry added.", path: authPath };
}

// ── Stateless auth.json access + locked provider-shaped writer (D3/D4) ──

/** Absolute path to the agent's auth.json (honors PI_CODING_AGENT_DIR). */
function getAuthFilePath(): string {
  return join(getAgentDir(), "auth.json");
}

/**
 * Read and parse auth.json fresh, returning the top-level object (or `{}` if the
 * file is missing / unreadable / not a JSON object). No caching — every call hits
 * disk, per the stateless contract (D3).
 */
export async function readAuthJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(getAuthFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid → behave as an empty store.
  }
  return {};
}

/** Result of a locked provider-shaped write. */
export interface ProviderWriteResult {
  readonly success: boolean;
  readonly message: string;
  readonly alreadyExists?: boolean;
}

/**
 * Acquire an exclusive advisory lock via an `O_EXCL` lockfile next to auth.json.
 * Retries with jittered backoff; force-clears a lock older than the timeout
 * (treated as stale). Returns a release function that removes the lockfile.
 */
async function acquireAuthLock(lockPath: string): Promise<() => Promise<void>> {
  const timeoutMs = 5000;
  const start = Date.now();
  for (;;) {
    try {
      // "wx" = O_CREAT | O_EXCL | O_WRONLY — fails if the lockfile already exists.
      const handle = await open(lockPath, "wx");
      await handle.close();
      return async (): Promise<void> => {
        try {
          await unlink(lockPath);
        } catch {
          // Already gone — nothing to release.
        }
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        // Presumed stale (holder crashed); clear it and retry.
        try {
          await unlink(lockPath);
        } catch {
          // Someone else cleared it first.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }
}

/**
 * Read-modify-write auth.json under an exclusive lock, then commit atomically via
 * temp-write + rename. `mutator` returns the next object to persist, or `null` to
 * abort with no write. Every intermediate file is chmod 0600.
 */
async function mutateAuthFileLocked(
  mutator: (current: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<{ changed: boolean }> {
  const authDir = getAgentDir();
  const authPath = join(authDir, "auth.json");
  const lockPath = `${authPath}.lock`;

  await mkdir(authDir, { recursive: true });
  const release = await acquireAuthLock(lockPath);
  try {
    let current: Record<string, unknown> = {};
    try {
      const raw = await readFile(authPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or invalid JSON → start fresh.
    }

    const next = mutator(current);
    if (next === null) return { changed: false };

    const content = `${JSON.stringify(next, null, 2)}\n`;
    const tmpPath = `${authPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, authPath);
      await chmod(authPath, 0o600);
    } catch (e) {
      try {
        await unlink(tmpPath);
      } catch {
        // Temp file may not exist — ignore.
      }
      throw e;
    }
    return { changed: true };
  } finally {
    await release();
  }
}

/**
 * Write a provider-shaped entry `{[name]:{type:"api_key",key}}` to auth.json under
 * the lock (D4). `key` is either a `!op read '<ref>'` command (vault) or a literal
 * secret (manual). Refuses to clobber an existing key unless `overwrite` is set.
 */
export async function writeProviderAuthEntry(
  name: string,
  key: string,
  options: { overwrite?: boolean } = {},
): Promise<ProviderWriteResult> {
  let alreadyExists = false;
  const { changed } = await mutateAuthFileLocked((current) => {
    alreadyExists = Object.hasOwn(current, name);
    if (alreadyExists && !options.overwrite) return null;
    return { ...current, [name]: { type: "api_key", key } };
  });
  if (!changed) {
    return {
      success: false,
      alreadyExists: true,
      message: `Key "${name}" already exists in auth.json. Use changeSecret (overwrite) or remove it first.`,
    };
  }
  return { success: true, message: "Entry saved." };
}

/**
 * Remove `parsed[name]` from auth.json under the lock. `ok` is `true` when an entry
 * was present and removed, `false` when there was nothing to remove.
 */
export async function deleteAuthEntry(name: string): Promise<{ ok: boolean }> {
  let existed = false;
  await mutateAuthFileLocked((current) => {
    if (!Object.hasOwn(current, name)) {
      existed = false;
      return null;
    }
    existed = true;
    const next = { ...current };
    delete next[name];
    return next;
  });
  return { ok: existed };
}

/**
 * Scan all auth.json values — top-level strings AND nested provider-shaped `.key`
 * values (D7; `loadShellEnvMap` inspects neither nested keys nor provider ids) —
 * for the first `!op read ` reference. Returns the trimmed value or `null`.
 */
export function findFirstOpRef(parsed: Record<string, unknown>): string | null {
  for (const value of Object.values(parsed)) {
    const candidate =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as { key?: unknown }).key
          : undefined;
    if (typeof candidate === "string" && /^!op read /.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Warm the 1Password account session on load (D7/D8). Scans auth.json for any
 * `!op read ` reference and, if one exists, runs a single best-effort `op read`
 * (value discarded) so the OS-level biometric prompt lands at startup. Silent and
 * fail-closed: never throws, does nothing when there are no vault references.
 */
export async function warmOpSessionIfNeeded(): Promise<void> {
  try {
    const parsed = await readAuthJson();
    const firstRef = findFirstOpRef(parsed);
    if (!firstRef) return;
    const ref = firstRef.replace(/^!op read\s+/, "").replace(/^['"]|['"]$/g, "");
    try {
      await execAsync(`op read "${ref}"`, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });
    } catch {
      // Best effort — a failed warm-up must not disrupt startup.
    }
  } catch {
    // Never let warm-on-load throw.
  }
}

/**
 * Interactive vault → item → field picker (custom bordered TUI) that returns a
 * fully-qualified `op://Vault/Item/field` reference or `null` on cancel. Used by
 * both the `/1password_setup` command and the public {@link onboardSecret} flow.
 */
export async function pickOpReferenceSimple(ctx: UiContext): Promise<string | null> {
  const browseHelp = "↑↓ • Enter • Esc = cancel • Type to filter";

  ctx.ui.setStatus("1p-onboard", "Loading vaults...");
  let vaultNames: string[] = [];
  try {
    const { stdout } = await execAsync(`op vault list --format json`, {
      encoding: "utf8",
      timeout: 20000,
    });
    const parsed = JSON.parse(stdout || "[]") as OpVault[];
    vaultNames = parsed.map((v) => v.name).sort((a, b) => a.localeCompare(b));
  } catch {
    ctx.ui.notify("Couldn't reach 1Password — make sure it's unlocked.", "warning");
    ctx.ui.setStatus("1p-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("1p-onboard", undefined);

  if (vaultNames.length === 0) {
    ctx.ui.notify("No vaults found in your 1Password account.", "warning");
    return null;
  }

  const vaultItems = [
    ...vaultNames.map((name) => ({ value: name, label: name })),
    { value: "__cancel", label: "Cancel" },
  ];
  const chosenVault = await selectInBorderedPopup(ctx, {
    title: "Choose a vault",
    items: vaultItems,
    helpText: browseHelp,
    maxVisible: 14,
  });
  if (!chosenVault || chosenVault === "__cancel") return null;

  ctx.ui.setStatus("1p-onboard", `Loading items from ${chosenVault}...`);
  let items: OpItem[] = [];
  try {
    const cmd = `op item list --vault ${JSON.stringify(chosenVault)} --categories "API Credential,Login,Secure Note,Password" --format json`;
    const { stdout } = await execAsync(cmd, {
      encoding: "utf8",
      timeout: 25000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || "[]") as OpItem[];
    items = parsed.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  } catch {
    ctx.ui.notify(`Couldn't load items from "${chosenVault}". Try again.`, "warning");
    ctx.ui.setStatus("1p-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("1p-onboard", undefined);

  if (items.length === 0) {
    ctx.ui.notify(`No API keys or logins found in "${chosenVault}".`, "warning");
    return null;
  }

  const itemItems = [
    ...items.map((it) => ({
      value: it.id,
      label: `${it.title}${it.category ? ` — ${it.category}` : ""}`,
    })),
    { value: "__cancel", label: "Cancel" },
  ];
  const chosenItemId = await selectInBorderedPopup(ctx, {
    title: `Choose an item in ${chosenVault}`,
    items: itemItems,
    helpText: browseHelp,
    maxVisible: 16,
  });
  if (!chosenItemId || chosenItemId === "__cancel") return null;

  const chosenItem = items.find((it) => it.id === chosenItemId);
  if (!chosenItem) return null;

  ctx.ui.setStatus("1p-onboard", "Loading fields...");
  let fields: { label: string; type?: string }[] = [];
  try {
    const { stdout } = await execAsync(
      `op item get ${JSON.stringify(chosenItem.id)} --format json`,
      {
        encoding: "utf8",
        timeout: 15000,
      },
    );
    const full = JSON.parse(stdout || "null") as { fields?: OpField[] } | null;
    fields = full?.fields?.filter(Boolean) ?? [];
  } catch {
    ctx.ui.notify("Couldn't load that item's fields. Try again.", "warning");
    ctx.ui.setStatus("1p-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("1p-onboard", undefined);

  if (fields.length === 0) {
    ctx.ui.notify("That item has no fields to use.", "warning");
    return null;
  }

  // Auto-skip the field step when the item has exactly one credential-type field
  // (a concealed value, or a label like password / credential / api key / secret /
  // token) — the overwhelmingly common case for an API-key item.
  const credentialFields = fields.filter(isCredentialField);
  let chosenFieldLabel: string | null;
  if (credentialFields.length === 1) {
    chosenFieldLabel = credentialFields[0]?.label ?? null;
  } else {
    const fieldItems = [
      ...fields.map((f) => ({
        value: f.label,
        label: `${f.label} (${f.type ?? "text"})`,
      })),
      { value: "__cancel", label: "Cancel" },
    ];
    chosenFieldLabel = await selectInBorderedPopup(ctx, {
      title: "Which field holds the key?",
      items: fieldItems,
      helpText: browseHelp,
      maxVisible: 12,
    });
    if (!chosenFieldLabel || chosenFieldLabel === "__cancel") return null;
  }
  if (!chosenFieldLabel) return null;

  return `op://${chosenVault}/${chosenItem.title}/${chosenFieldLabel}`;
}

/**
 * Heuristic: does this 1Password field hold a credential value? True for a
 * concealed field, or a label naming a password / credential / api key / secret /
 * token. Uses only the field's label and type — never its value — so nothing
 * secret is read here.
 */
function isCredentialField(field: { label: string; type?: string }): boolean {
  const type = (field.type ?? "").toUpperCase();
  const label = field.label.toLowerCase();
  return type === "CONCEALED" || /password|credential|api[\s_-]?key|secret|token/.test(label);
}

// ── Tool schemas ───────────────────────────────────────────────────────

const diagnoseSchema = Type.Object({});
export type DiagnoseInput = Static<typeof diagnoseSchema>;

// ── Extension factory ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  // Load initial shell env (top-level keys from auth.json)
  currentShellEnv = await loadShellEnvMap();

  // Load curated list for /1password_setup
  curatedPlugins = await loadCuratedPlugins();

  // Warm the 1Password account session if any auth.json value uses `!op read`
  // (D7/D8) so the OS-level biometric prompt lands once, at startup. No-op and
  // silent when there are no vault references.
  await warmOpSessionIfNeeded();

  // ── Bash tool wrapper with transparent 1P env injection ───────────────
  const cwd = process.cwd();
  const injectedBash = createBashTool(cwd, {
    spawnHook: ({ command, cwd: hookCwd, env }) => ({
      command,
      cwd: hookCwd,
      env: { ...env, ...currentShellEnv },
    }),
  });
  pi.registerTool(injectedBash);

  // Transparent 1P injection for user `!bash` commands — only when the runtime
  // exposes `createLocalBashOperations` (real pi does; oh-my-pi's compat shim does
  // not). Absent it, we skip the hook rather than crash the module load.
  if (typeof piRuntime.createLocalBashOperations === "function") {
    pi.on("user_bash", () => ({ operations: piRuntime.createLocalBashOperations() }));
  } else if (process.env.HEADROOM_DEBUG) {
    console.error(
      "[1password] createLocalBashOperations unavailable on this runtime; user `!` 1P injection disabled (transparent agent-bash injection still active).",
    );
  }

  pi.on("session_start", async () => {
    currentShellEnv = await loadShellEnvMap();
    curatedPlugins = await loadCuratedPlugins();
    await warmOpSessionIfNeeded();
  });

  // ── Shared diagnostic logic (used by both 1p_diagnose tool and /1password_diagnose command) ──
  async function get1PasswordDiagnosticReport() {
    const status = await getOpStatus();

    const commonPlugins = ["gh", "aws", "heroku"];
    const inspections: PluginInspection[] = [];

    for (const p of commonPlugins) {
      const info = await inspectPluginIfRelevant(p);
      if (info) inspections.push(info);
    }

    let report = `${formatOpStatus(status)}\n\n`;

    if (inspections.length > 0) {
      report += "Plugin configuration:\n";
      for (const i of inspections) {
        report += `\n--- ${i.plugin} ---\n${i.output ?? i.error ?? ""}\n`;
      }
    } else {
      report += "No common plugins inspected (or none configured).\n";
    }

    const injectedNames = getShellEnvNames();
    report += "\nShell env injection (transparent for all bash + ! commands):\n";
    if (injectedNames.length > 0) {
      report += `Active vars (names only): ${injectedNames.join(", ")}\n`;
      report += "Source: top-level keys in ~/.pi/agent/auth.json using !op read (or literals).\n";
      report += "These are injected via spawn hook — LLM never sees the values.\n";
    } else {
      report += "No shell env vars currently injected from auth.json.\n";
      report +=
        'Add e.g. "GH_TOKEN": "!op read \'op://Vault/Item/credential\'" to ~/.pi/agent/auth.json (restart or /reload to pick up).\n';
    }

    return {
      report: report.trim(),
      details: {
        opStatus: status,
        pluginInspections: inspections,
        injectedShellEnvNames: injectedNames,
      },
    };
  }

  // ── 1p_diagnose (tool for the LLM) ─────────────────────────────────────
  pi.registerTool({
    name: "1p_diagnose",
    label: "1Password Diagnostics",
    description:
      "Check the current status of the 1Password CLI (`op`), sign-in state, plugin configuration, and active shell env injection (from ~/.pi/agent/auth.json). Use this when 1password_setup or 1password_diagnose are not working as expected, or to verify transparent token injection for bare `gh` / `aws` etc.",
    parameters: diagnoseSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const { report, details } = await get1PasswordDiagnosticReport();
      return {
        content: [{ type: "text", text: report }],
        details,
      };
    },
  });

  // ── /1password_diagnose (user-facing command) ──────────────────────────
  pi.registerCommand("1password_diagnose", {
    description:
      "Run full 1Password diagnostics. Gathers op status, plugin configuration, and active injected variables, then presents a clean report directly (no extra user prompting required).",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Running 1Password diagnostics...", "info");

      // The command performs the diagnostics directly using privileged access.
      // This guarantees you get a complete, reliable report the moment you run the command.
      const { report } = await get1PasswordDiagnosticReport();

      ctx.ui.notify(report, "info");
    },
  });

  // TODO (known limitation): /1password_diagnose currently gathers data directly
  // for reliability and presents it. Injecting a prompt via sendUserMessage does not
  // reliably cause the LLM to start a new turn and use 1p_diagnose for
  // nicer formatting, because regular command handlers have limited access to
  // the "deliverAs: nextTurn" / sendUserMessage APIs that force LLM reasoning.
  // This should be revisited when better support exists or a different pattern
  // is found. Tracked as a follow-up issue.

  // Vault → item → field picker now lives at module scope as the exported
  // pickOpReferenceSimple (reused by the public onboardSecret API).

  // ── /1password_setup — fully custom bordered TUI onboarding (curated + manual + vault/item/field)
  pi.registerCommand("1password_setup", {
    description:
      "Guided setup: pick from supported tools or enter a custom op:// reference, write '!op read ...' entry to ~/.pi/agent/auth.json for transparent injection.",
    handler: async (_args, ctx) => {
      const authPath = join(homedir() || "/tmp", ".pi", "agent", "auth.json");

      ctx.ui.notify("1Password Onboard — transparent env injection setup", "info");

      const hasCurated = curatedPlugins.length > 0;
      const firstChoices = [
        hasCurated ? "Pick from a list of supported tools" : "",
        "Enter environment variable + secret reference manually",
        "Cancel",
      ].filter(Boolean);

      const firstItems = firstChoices.map((c) => ({ value: c, label: c }));
      const mode = await selectInBorderedPopup(ctx, {
        title: "1Password Onboard — How would you like to start?",
        items: firstItems,
        helpText: "↑↓ • Enter • Esc = cancel",
        maxVisible: 5,
      });
      if (!mode || mode === "Cancel") {
        ctx.ui.notify("Onboarding cancelled.", "info");
        return;
      }

      let finalEnv: string | null = null;
      let opRef: string | null = null;

      if (mode.startsWith("Pick from a list of supported tools")) {
        // Rich bordered two-step picker for curated tools (supports multi-env tools
        // such as AWS, Argo CD, etc.). Uses the polished custom TUI (filterable lists,
        // consistent ╭─╮ borders, stable right-edge alignment, live filtering, Esc cancel).
        if (curatedPlugins.length === 0) {
          ctx.ui.notify("No curated tools available right now.", "warning");
          return;
        }

        const toolItems = curatedPlugins.map((p) => ({
          value: p.name,
          label: p.name,
          description:
            p.envVars.length > 0
              ? `${p.primaryEnvVar ?? p.envVars[0] ?? ""} (+${String(p.envVars.length - 1)} more)`
              : "custom / no standard env var",
        }));

        const chosenToolName = await selectInBorderedPopup(ctx, {
          title: "Select tool (type to filter)",
          items: toolItems,
          helpText: "↑↓ • Enter • Esc = cancel • Type to filter curated 1P shell plugins",
          maxVisible: 16,
        });
        if (!chosenToolName) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }

        const tool = curatedPlugins.find((p) => p.name === chosenToolName);
        if (!tool) {
          ctx.ui.notify("Selected tool is no longer available.", "error");
          return;
        }

        // Two-step: if the chosen tool declares multiple env vars, let the user pick which one.
        if (tool.envVars.length > 1) {
          const envItems = tool.envVars.map((v) => ({
            value: v,
            label: v,
            description: v === tool.primaryEnvVar ? "primary / recommended" : undefined,
          }));

          const chosenEnv = await selectInBorderedPopup(ctx, {
            title: `Environment variable for ${tool.name}`,
            items: envItems,
            helpText: "↑↓ • Enter to choose which var to inject • Esc = back",
            maxVisible: Math.min(12, tool.envVars.length + 2),
          });
          if (!chosenEnv) {
            ctx.ui.notify("Onboarding cancelled.", "info");
            return;
          }
          finalEnv = chosenEnv;
        } else {
          finalEnv = tool.primaryEnvVar ?? tool.envVars[0] ?? null;
        }

        if (!finalEnv) {
          ctx.ui.notify("Selected tool has no declared environment variable.", "error");
          return;
        }

        opRef = await pickOpReferenceSimple(ctx);
        if (!opRef) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
      } else {
        // Manual path — also using the custom bordered UI for consistency
        const envVar = await inputInBorderedPopup(ctx, {
          title: "Environment variable name",
          prompt: "Enter the UPPER_SNAKE_CASE name for the secret (e.g. GH_TOKEN)",
          helpText: "Enter to confirm • Esc = cancel",
        });
        if (!envVar) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
        if (!/^[A-Z0-9_]+$/.test(envVar)) {
          ctx.ui.notify("Invalid env var name (must be UPPER_SNAKE_CASE).", "error");
          return;
        }
        finalEnv = envVar;

        const refMethod = await selectInBorderedPopup(ctx, {
          title: "How do you want to provide the secret location?",
          items: [
            { value: "manual", label: "Type the op:// reference manually" },
            { value: "lookup", label: "Look it up in 1Password" },
          ],
          helpText: "↑↓ • Enter • Esc = cancel",
          maxVisible: 5,
        });
        if (!refMethod) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }

        if (refMethod === "manual") {
          const manualRef = await inputInBorderedPopup(ctx, {
            title: "op:// Reference",
            prompt: "Enter the full 1Password reference",
            defaultValue: "op://Vault/Item/field",
            helpText: "Must start with op:// • Enter to confirm • Esc = cancel",
          });
          if (!manualRef?.startsWith("op://")) {
            ctx.ui.notify("Invalid reference (must start with op://) or cancelled.", "error");
            return;
          }
          opRef = manualRef;
        } else {
          opRef = await pickOpReferenceSimple(ctx);
        }
        if (!opRef) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
      }

      // Shared preview + write tail (works for both paths)
      const previewLine = `"${finalEnv}": "!op read '${opRef}'"`;
      const previewMsg =
        `File: ${authPath}\n\n${previewLine}\n\n` +
        "After write: run /reload (or restart Pi). The spawn hook will inject the variable into bash/! commands.\n" +
        "Use /1password_diagnose to verify (names only; values never leave the host).";

      const confirmed = await confirmInBorderedPopup(ctx, {
        title: "Add this to auth.json?",
        message: previewMsg,
      });
      if (!confirmed) {
        ctx.ui.notify("Cancelled — nothing written.", "info");
        return;
      }

      let writeRes = await addAuthEntry(finalEnv, opRef);

      if (!writeRes.success && writeRes.message.includes("already exists")) {
        const overwrite = await confirmInBorderedPopup(ctx, {
          title: `Key "${finalEnv}" already exists, overwrite?`,
          message: "Replace the current value in auth.json?",
        });
        if (overwrite) {
          writeRes = await addAuthEntry(finalEnv, opRef, { overwrite: true });
        } else {
          ctx.ui.notify(writeRes.message, "warning");
          return;
        }
      }

      if (writeRes.success) {
        ctx.ui.notify(`✅ Success! ${finalEnv} added to auth.json (0600).`, "info");
        const doReload = await confirmInBorderedPopup(ctx, {
          title: "Activate now?",
          message: "Run /reload so the spawn hook starts injecting it this session?",
        });
        if (doReload) {
          await ctx.reload();
        } else {
          ctx.ui.notify("Run `/reload` when ready.", "info");
        }
      } else {
        ctx.ui.notify(writeRes.message, "warning");
      }
    },
  });
}
