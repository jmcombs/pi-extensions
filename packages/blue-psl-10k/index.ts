/**
 * @jmcombs/pi-blue-psl-10k — Powerline-styled footer with Blue PSL 10K theme.
 *
 * Replaces the default Pi footer with a single-line Powerline status bar
 * showing git status, context usage, token counts, model, and cost.
 * Bundles the Blue PSL 10K theme for a matching look.
 *
 * Data sources:
 *   - Git branch/status via child_process.execSync
 *   - CWD via ctx.sessionManager.getCwd()
 *   - Tokens/cost from ctx.sessionManager.getBranch() message usage
 *   - Context % via ctx.getContextUsage()
 *   - Model ID via ctx.model?.id
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { cwd, platform } from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ── Powerline Glyphs ───────────────────────────────────────────────────

const ARROW_RIGHT = "\uE0B0"; //  solid right-pointing triangle
const ARROW_LEFT = "\uE0B2"; //  solid left-pointing triangle

// ── Color Palette (Blue PSL 10K) ───────────────────────────────────────

const COLORS = {
  PATH_BG: "#3465a4", // Path Blue
  PATH_FG: "#eff1f5", // base (light text)
  MODEL_BG: "#1e66f5", // Blue
  MODEL_FG: "#eff1f5", // base
  GIT_CLEAN: "#40a02b", // Green
  GIT_DIRTY: "#df8e1d", // Yellow
  GIT_CONFLICT: "#e64553", // Maroon (ahead + behind)
  GIT_AHEAD: "#04a5e5", // Sky (only ahead)
  GIT_FG: "#eff1f5", // base
  CONTEXT_GREEN: "#40a02b",
  CONTEXT_YELLOW: "#df8e1d",
  CONTEXT_ORANGE: "#fe640b",
  CONTEXT_RED: "#d20f39",
  CONTEXT_FG: "#eff1f5",
  DIM_BG: "#179299", // Teal for dims
  DIM_FG: "#eff1f5",
  COST_BG: "#fe640b", // Peach
  COST_FG: "#eff1f5",
  THINKING_MINIMAL_BG: "#6c6f85", // muted
  THINKING_LOW_BG: "#1e66f5", // blue
  THINKING_MEDIUM_BG: "#179299", // teal
  THINKING_HIGH_BG: "#04a5e5", // sky
  THINKING_XHIGH_BG: "#8839ef", // mauve
  THINKING_FG: "#eff1f5",
  TERMINAL_BG: "#eff1f5", // fallback terminal bg (matches base)
  TERMINAL_FG: "#4c4f69", // fallback terminal fg (matches text)
} as const;

// ── ANSI Helpers (true-color 24-bit) ───────────────────────────────────

const ESC = "\x1b";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fgRgb(r: number, g: number, b: number): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

function bgRgb(r: number, g: number, b: number): string {
  return `${ESC}[48;2;${r};${g};${b}m`;
}

function fgHex(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return fgRgb(r, g, b);
}

function bgHex(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return bgRgb(r, g, b);
}

function reset(): string {
  return `${ESC}[0m`;
}

// ── Data Gathering ─────────────────────────────────────────────────────

const OS_ICON: string =
  platform === "darwin"
    ? "" //
    : platform === "linux"
      ? "" //
      : platform === "win32"
        ? "" //
        : "";

function tildeCwd(cwdPath: string): string {
  const home = homedir();
  if (cwdPath === home) return "~";
  if (cwdPath.startsWith(`${home}/`)) return `~${cwdPath.slice(home.length)}`;
  return cwdPath;
}

interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

function getGitStatus(): GitStatus | null {
  try {
    const gitCwd = cwd();
    const branch = execSync("git branch --show-current", {
      cwd: gitCwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 2000,
    }).trim();

    const porcelain = execSync("git status --porcelain", {
      cwd: gitCwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 2000,
    }).trim();

    const hasChanges = porcelain.length > 0;

    let ahead = 0;
    let behind = 0;

    try {
      const upstream = execSync("git rev-parse --abbrev-ref @{upstream}", {
        cwd: gitCwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 2000,
      }).trim();

      if (upstream && upstream !== "HEAD") {
        const result = execSync("git rev-list --count --left-right @{upstream}...HEAD", {
          cwd: gitCwd,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 2000,
        }).trim();
        // Output is tab-separated: "<behind>\t<ahead>"
        const parts = result.split("\t").map((s) => parseInt(s, 10) || 0);
        behind = parts[0] ?? 0;
        ahead = parts[1] ?? 0;
      }
    } catch {
      // No upstream configured
    }

    return {
      branch: branch || "(no branch)",
      dirty: hasChanges,
      ahead,
      behind,
    };
  } catch {
    return null;
  }
}

function formatGitStatus(status: GitStatus): { text: string; bg: string } {
  const bgMap = {
    clean: COLORS.GIT_CLEAN,
    dirty: COLORS.GIT_DIRTY,
    conflict: COLORS.GIT_CONFLICT,
    ahead: COLORS.GIT_AHEAD,
  };

  let bg: string;
  if (status.ahead > 0 && status.behind > 0) {
    bg = bgMap.conflict;
  } else if (status.ahead > 0) {
    bg = bgMap.ahead;
  } else if (status.dirty) {
    bg = bgMap.dirty;
  } else {
    bg = bgMap.clean;
  }

  let indicator = "";
  if (status.dirty) {
    // OMP-style: + = staged, ! = unstaged, ? = untracked
    try {
      const porcelain = execSync("git status --porcelain", {
        cwd: cwd(),
        encoding: "utf8",
        stdio: "pipe",
        timeout: 2000,
      }).trim();
      const lines = porcelain.split("\n").filter(Boolean);
      const staged = lines.some((l) => /[A-MRCDRU]/.test(l[0] ?? ""));
      const unstaged = lines.some((l) => /[A-MRCDRU]/.test(l[1] ?? ""));
      const untracked = lines.some((l) => l.startsWith("??"));
      indicator = (staged ? "+" : "") + (unstaged ? "!" : "") + (untracked ? "?" : "");
    } catch {
      indicator = "!";
    }
  }

  const aheadBehind = [
    status.behind > 0 ? `↓${status.behind}` : "",
    status.ahead > 0 ? `↑${status.ahead}` : "",
  ]
    .filter(Boolean)
    .join("/");
  const parts = [status.branch]
    .concat(indicator ? [indicator] : [])
    .concat(aheadBehind ? [aheadBehind] : []);

  return {
    text: parts.join(" "),
    bg,
  };
}

interface TokenCost {
  readTokens: number;
  writeTokens: number;
  cacheHitPct: number | null; // null when no input tokens (nothing to compute a % from)
  totalCost: number;
}

function getTokenCost(session: ExtensionContext): TokenCost {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let writeTokens = 0;
  let totalCost = 0;

  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
      const usage = entry.message.usage;
      inputTokens += usage.input;
      cacheReadTokens += usage.cacheRead;
      writeTokens += usage.output + usage.cacheWrite;
      totalCost += usage.cost?.total ?? 0;
    }
  }

  const readTokens = inputTokens + cacheReadTokens;
  const totalInput = inputTokens + cacheReadTokens;
  const cacheHitPct = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : null;
  return { readTokens, writeTokens, cacheHitPct, totalCost };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

// ── Footer Renderer ────────────────────────────────────────────────────

type Segment = { text: string; fg: string; bg: string };

function buildLine(left: Segment[], right: Segment[], width: number): string {
  let leftRaw = "";
  for (const [i, seg] of left.entries()) {
    leftRaw += `${bgHex(seg.bg)}${fgHex(seg.fg)} ${seg.text} `;
    const nextBg = left[i + 1]?.bg;
    if (nextBg !== undefined) {
      leftRaw += fgHex(seg.bg) + bgHex(nextBg) + ARROW_RIGHT;
    } else {
      leftRaw += reset() + fgHex(seg.bg) + ARROW_RIGHT + reset();
    }
  }

  let rightRaw = "";
  for (const [i, seg] of right.entries()) {
    if (i === 0) {
      rightRaw += fgHex(seg.bg) + ARROW_LEFT;
    } else {
      rightRaw += bgHex(right[i - 1]?.bg ?? "") + fgHex(seg.bg) + ARROW_LEFT;
    }
    rightRaw += `${bgHex(seg.bg)}${fgHex(seg.fg)} ${seg.text} `;
  }
  rightRaw += reset();

  const padWidth = Math.max(0, width - visibleWidth(leftRaw) - visibleWidth(rightRaw));
  return truncateToWidth(leftRaw + " ".repeat(padWidth) + rightRaw, width);
}

function createFooter(session: ExtensionContext) {
  // getThinkingLevel() lives on ExtensionCommandContext, not ExtensionContext.
  // Seed from branch history then track via thinking_level_select events.
  let currentThinkingLevel = "off";
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "thinking_level_change") {
      currentThinkingLevel = entry.thinkingLevel;
    }
  }

  function render(width: number): string[] {
    const cwdPath = session.sessionManager.getCwd() ?? cwd();
    const gitStatus = getGitStatus();
    const { readTokens, writeTokens, cacheHitPct, totalCost } = getTokenCost(session);
    const contextUsage = session.getContextUsage();
    const modelId = session.model?.id ?? "";

    // ── Line 1 segments ──────────────────────────────────────────────
    const line1Left: Segment[] = [];
    const line1Right: Segment[] = [];

    const pathText = OS_ICON ? `${OS_ICON} ${tildeCwd(cwdPath || ".")}` : tildeCwd(cwdPath || ".");
    line1Left.push({ text: pathText, fg: COLORS.PATH_FG, bg: COLORS.PATH_BG });

    if (gitStatus) {
      const { text: gitText, bg: gitBg } = formatGitStatus(gitStatus);
      line1Left.push({ text: gitText, fg: COLORS.GIT_FG, bg: gitBg });
    }

    if (totalCost > 0) {
      line1Right.push({
        text: `💰 $${totalCost.toFixed(3)}`,
        fg: COLORS.COST_FG,
        bg: COLORS.COST_BG,
      });
    }

    const thinkingLevel = currentThinkingLevel;
    if (thinkingLevel !== "off") {
      const thinkingBg =
        {
          minimal: COLORS.THINKING_MINIMAL_BG,
          low: COLORS.THINKING_LOW_BG,
          medium: COLORS.THINKING_MEDIUM_BG,
          high: COLORS.THINKING_HIGH_BG,
          xhigh: COLORS.THINKING_XHIGH_BG,
        }[thinkingLevel] ?? COLORS.THINKING_MINIMAL_BG;
      const thinkingLabel =
        { minimal: "min", low: "low", medium: "med", high: "high", xhigh: "max" }[thinkingLevel] ??
        thinkingLevel;
      line1Right.push({ text: `🧠 ${thinkingLabel}`, fg: COLORS.THINKING_FG, bg: thinkingBg });
    }

    if (modelId) {
      line1Right.push({ text: `🤖 ${modelId}`, fg: COLORS.MODEL_FG, bg: COLORS.MODEL_BG });
    }

    // ── Line 2 segments (right-aligned, under model) ─────────────────
    const line2Right: Segment[] = [];

    if (readTokens > 0 || writeTokens > 0) {
      line2Right.push({
        text: `📊 ↓${formatNumber(readTokens)} ↑${formatNumber(writeTokens)}`,
        fg: COLORS.DIM_FG,
        bg: COLORS.DIM_BG,
      });
    }

    if (cacheHitPct !== null && cacheHitPct > 0) {
      line2Right.push({
        text: `cache ${cacheHitPct}%`,
        fg: COLORS.CONTEXT_FG,
        bg: COLORS.GIT_CLEAN,
      });
    }

    if (contextUsage && contextUsage.tokens != null) {
      const contextWindow = session.model?.contextWindow ?? 200_000;
      const pct = Math.round((contextUsage.tokens / contextWindow) * 100);
      let ctxBg: string;
      if (pct >= 90) {
        ctxBg = COLORS.CONTEXT_RED;
      } else if (pct >= 80) {
        ctxBg = COLORS.CONTEXT_ORANGE;
      } else if (pct >= 50) {
        ctxBg = COLORS.CONTEXT_YELLOW;
      } else {
        ctxBg = COLORS.CONTEXT_GREEN;
      }
      line2Right.push({ text: `ctx ${pct}%`, fg: COLORS.CONTEXT_FG, bg: ctxBg });
    }

    const lines = [buildLine(line1Left, line1Right, width)];
    if (line2Right.length > 0) {
      lines.push(buildLine([], line2Right, width));
    }
    return lines;
  }

  return {
    render,
    setThinkingLevel(level: string) {
      currentThinkingLevel = level;
    },
  };
}

function visibleWidth(str: string): number {
  // Strip ANSI CSI sequences (e.g. \x1b[38;2;52;73;164m, \x1b[0m)
  const stripped = str.replace(new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g"), "");
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // Zero-width: ZWJ, ZWSP, BOM, variation selectors (handles 🗄️ U+FE0F etc.)
    if (cp === 0x200d || cp === 0x200b || cp === 0xfeff) continue;
    if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) continue;
    // Powerline private-use arrows: 1 cell (Nerd Font standard)
    if (cp === 0xe0b0 || cp === 0xe0b2) {
      width += 1;
      continue;
    }
    // Supplementary plane (U+10000+): emoji — 2 cells
    if (cp > 0xffff) {
      width += 2;
      continue;
    }
    // ASCII and BMP non-ASCII (arrows ↑↓, Latin, etc.) — 1 cell
    width += 1;
  }
  return width;
}

// ── Extension Factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  let currentTui: { invalidate(): void } | null = null;
  let currentFooter: ReturnType<typeof createFooter> | null = null;

  function triggerRedraw(): void {
    currentTui?.invalidate();
  }

  pi.on("session_start", (_event, ctx) => {
    currentFooter = createFooter(ctx);
    const footer = currentFooter;
    ctx.ui.setFooter((tui, _theme) => {
      currentTui = tui;
      return {
        render: (width: number) => footer.render(width),
        invalidate: () => {},
        dispose: () => {
          currentTui = null;
        },
      };
    });
  });

  // Registered once at the top level — not inside session_start — so they
  // do not accumulate on every session start and do not keep extra event-loop
  // references alive during pi install / pi update.
  pi.on("model_select", () => triggerRedraw());
  pi.on("turn_end", () => triggerRedraw());
  pi.on("thinking_level_select", (event) => {
    currentFooter?.setThinkingLevel(event.level);
    triggerRedraw();
  });

  pi.registerCommand("blue-psl-restore-footer", {
    description: "Restore the default Pi footer (remove Blue PSL 10k powerline footer).",
    handler: (_args, ctx) => {
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Default footer restored", "info");
      return Promise.resolve();
    },
  });
}
