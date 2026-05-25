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

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

import {
  confirmInBorderedPopup,
  inputInBorderedPopup,
  selectInBorderedPopup,
} from "./ui/bordered-popups.js";

const execAsync = promisify(exec);

// ── Internal helpers for diagnostics (properly typed) ──────────────────

interface OpStatus {
  available: boolean;
  version: string | null;
  signedIn: boolean;
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

async function getOpStatus(): Promise<OpStatus> {
  try {
    const { stdout } = await execAsync("op --version", { encoding: "utf8" });
    const version = stdout.trim();

    try {
      const { stdout: whoamiOut } = await execAsync("op whoami --format json", {
        encoding: "utf8",
      });
      const whoami = JSON.parse(whoamiOut) as Record<string, unknown>;
      return {
        available: true,
        version,
        signedIn: true,
        account: whoami,
      };
    } catch {
      return {
        available: true,
        version,
        signedIn: false,
        account: null,
      };
    }
  } catch {
    return {
      available: false,
      version: null,
      signedIn: false,
      account: null,
    };
  }
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
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const msg = (error.stderr?.trim() ?? error.message) || "Unknown error";
    return { plugin: firstWord, error: msg };
  }
}

function formatOpStatus(status: OpStatus): string {
  if (!status.available) {
    return "1Password CLI (`op`) is not available in PATH.";
  }
  if (!status.signedIn) {
    return `op ${status.version ?? "unknown"} is installed but you are not signed in.`;
  }
  const acct = status.account ?? {};
  const name =
    (acct.name as string | undefined) ??
    (acct.email as string | undefined) ??
    (acct.account_uuid as string | undefined) ??
    "unknown";
  const url = (acct.url as string | undefined) ?? "unknown account";
  return `op ${status.version ?? "unknown"} — signed in as ${name} (${url})`;
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

async function resolveShellValue(raw: unknown): Promise<string | null> {
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename
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

// Curated shell plugin list (loaded once at startup for /1password_onboard suggestions)
let curatedPlugins: CuratedPlugin[] = [];

/** Returns the *names* of currently injected shell env vars (never the values). Safe for diagnostics / LLM. */
export function getShellEnvNames(): string[] {
  return Object.keys(currentShellEnv);
}

// ── Curated list + auth.json writer (for /1password_onboard) ────────────

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

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(authDir, { recursive: true });

  const existing = new Map<string, unknown>();
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
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

  const content = JSON.stringify(Object.fromEntries(existing), null, 2) + "\n";
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(authPath, content, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await chmod(authPath, 0o600);

  return { success: true, message: "Entry added.", path: authPath };
}

// ── Tool schemas ───────────────────────────────────────────────────────

const runSchema = Type.Object({
  command: Type.String({
    description:
      "The command to run with 1Password credential injection (e.g. 'gh auth status' or 'gh repo view owner/repo')",
  }),
});
export type RunInput = Static<typeof runSchema>;

const diagnoseSchema = Type.Object({});
export type DiagnoseInput = Static<typeof diagnoseSchema>;

// ── Extension factory ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  // Load initial shell env (top-level keys from auth.json)
  currentShellEnv = await loadShellEnvMap();

  // Load curated list for /1password_onboard
  curatedPlugins = await loadCuratedPlugins();

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

  pi.on("user_bash", () => {
    return { operations: createLocalBashOperations() };
  });

  pi.on("session_start", async () => {
    currentShellEnv = await loadShellEnvMap();
    curatedPlugins = await loadCuratedPlugins();
  });

  // ── 1p_run ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "1p_run",
    label: "1Password Run Command",
    description:
      "Run a shell command with 1Password credential injection via `op run -- <command>`. Includes automatic diagnostics on failure.",
    parameters: runSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const status = await getOpStatus();
      const pluginInfo = await inspectPluginIfRelevant(params.command);

      if (!status.available) {
        return {
          content: [{ type: "text", text: `1p_run failed: ${formatOpStatus(status)}` }],
          details: { error: "op not found", opStatus: status },
        };
      }
      if (!status.signedIn) {
        return {
          content: [
            {
              type: "text",
              text: `1p_run failed: ${formatOpStatus(status)}\n\nPlease run 'op signin' in your terminal.`,
            },
          ],
          details: { error: "not signed in", opStatus: status },
        };
      }

      try {
        const { stdout, stderr } = await execAsync(`op run -- ${params.command}`, {
          encoding: "utf8",
          maxBuffer: 5 * 1024 * 1024,
          timeout: 120000,
        });

        const output = (stdout || "").trim();
        const err = (stderr || "").trim();

        let text = output || "(no stdout)";
        if (err) text += `\n\n[stderr]\n${err}`;

        return {
          content: [{ type: "text", text }],
          details: {
            command: params.command,
            opStatus: status,
            pluginInspection: pluginInfo,
          },
        };
      } catch (error: unknown) {
        const err = error as { stderr?: string; message?: string };
        const rawError = (err.stderr?.trim() ?? err.message ?? "") || String(error);
        const diagnostic = formatOpStatus(status);

        let helpful = `Command failed under 1Password injection.\n\n${diagnostic}`;

        if (pluginInfo) {
          helpful += `\n\nPlugin status for "${pluginInfo.plugin}":\n${pluginInfo.output ?? pluginInfo.error ?? ""}`;
        }

        helpful += `\n\nError from command:\n${rawError}`;

        return {
          content: [{ type: "text", text: helpful }],
          details: {
            error: rawError,
            command: params.command,
            opStatus: status,
            pluginInspection: pluginInfo,
          },
        };
      }
    },
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

    let report = formatOpStatus(status) + "\n\n";

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
      "Check the current status of the 1Password CLI (`op`), sign-in state, plugin configuration, and active shell env injection (from ~/.pi/agent/auth.json). Use this when 1password_onboard or 1password_diagnose are not working as expected, or to verify transparent token injection for bare `gh` / `aws` etc. (uses 1p_run for plugin inspection).",
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
  // reliably cause the LLM to start a new turn and use 1p_diagnose/1p_run for
  // nicer formatting, because regular command handlers have limited access to
  // the "deliverAs: nextTurn" / sendUserMessage APIs that force LLM reasoning.
  // This should be revisited when better support exists or a different pattern
  // is found. Tracked as a follow-up issue.

  // Local helper: vault → item → field picker using the custom bordered TUI.
  // Long lists benefit from live filtering. Esc (or picking Cancel) backs out.
  async function pickOpReferenceSimple(ctx: ExtensionCommandContext): Promise<string | null> {
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
      ctx.ui.notify("Failed to load vaults from 1Password.", "error");
      ctx.ui.setStatus("1p-onboard", undefined);
      return null;
    }
    ctx.ui.setStatus("1p-onboard", undefined);

    if (vaultNames.length === 0) {
      ctx.ui.notify("No vaults found in 1Password.", "warning");
      return null;
    }

    const vaultItems = [
      ...vaultNames.map((name) => ({ value: name, label: name })),
      { value: "__cancel", label: "Cancel" },
    ];
    const chosenVault = await selectInBorderedPopup(ctx, {
      title: "Select 1Password vault",
      items: vaultItems,
      helpText: "↑↓ • Enter • Esc = cancel • Type to filter",
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
      ctx.ui.notify("Failed to load items.", "error");
      ctx.ui.setStatus("1p-onboard", undefined);
      return null;
    }
    ctx.ui.setStatus("1p-onboard", undefined);

    if (items.length === 0) {
      ctx.ui.notify("No matching items in that vault.", "warning");
      return null;
    }

    const itemItems = [
      ...items.map((it) => ({
        value: it.id,
        label: `${it.title}${it.category ? " — " + it.category : ""}`,
      })),
      { value: "__cancel", label: "Cancel" },
    ];
    const chosenItemId = await selectInBorderedPopup(ctx, {
      title: `Select item in ${chosenVault}`,
      items: itemItems,
      helpText: "↑↓ • Enter • Esc = cancel • Type to filter (can be long)",
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
        { encoding: "utf8", timeout: 15000 },
      );
      const full = JSON.parse(stdout || "null") as { fields?: OpField[] } | null;
      fields = full?.fields?.filter(Boolean) ?? [];
    } catch {
      ctx.ui.notify("Failed to load fields.", "error");
      ctx.ui.setStatus("1p-onboard", undefined);
      return null;
    }
    ctx.ui.setStatus("1p-onboard", undefined);

    if (fields.length === 0) {
      ctx.ui.notify("Selected item has no fields.", "warning");
      return null;
    }

    const fieldItems = [
      ...fields.map((f) => ({
        value: f.label,
        label: `${f.label} (${f.type ?? "text"})`,
      })),
      { value: "__cancel", label: "Cancel" },
    ];
    const chosenFieldLabel = await selectInBorderedPopup(ctx, {
      title: `Select field for "${chosenItem.title}"`,
      items: fieldItems,
      helpText: "↑↓ • Enter • Esc = cancel",
      maxVisible: 12,
    });
    if (!chosenFieldLabel || chosenFieldLabel === "__cancel") return null;

    return `op://${chosenVault}/${chosenItem.title}/${chosenFieldLabel}`;
  }

  // ── /1password_onboard — fully custom bordered TUI onboarding (curated + manual + vault/item/field)
  pi.registerCommand("1password_onboard", {
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
