/**
 * @jmcombs/pi-notify — Terminal-emulator notifications for Pi via OSC.
 *
 * Sends a notification using the host terminal's native notification system
 * (OSC 777/9/99 protocols) when the agent finishes a turn and is waiting for
 * input. Notifications are managed entirely by the terminal emulator
 * (Ghostty, iTerm2, WezTerm, Kitty, etc.), making this OS-agnostic with zero
 * injected OS binaries, packages, or dependencies beyond Node built-ins.
 *
 * On terminals that do not support the OSC notification protocols, the
 * extension surfaces a clear message via the TUI and recommends filing an
 * issue.
 *
 * Any audible notification is a side-effect of the terminal emulator + OS
 * when it renders the OSC notification we emit. This extension adds no
 * audio commands, beeps, or thresholds.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── OSC primitives ─────────────────────────────────────────────────────

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\"; // String Terminator (for OSC 99 and tmux DCS)

function wrapForTmux(sequence: string): string {
  if (!process.env.TMUX) return sequence;
  // Double-escape inner ESC bytes for tmux DCS passthrough
  const escaped = sequence.split(ESC).join(`${ESC}${ESC}`);
  return `${ESC}Ptmux;${escaped}${ST}`;
}

function notifyOSC777(title: string, body: string): void {
  const seq = `${ESC}]777;notify;${title};${body}${BEL}`;
  process.stdout.write(wrapForTmux(seq));
}

function notifyOSC9(message: string): void {
  const seq = `${ESC}]9;${message}${BEL}`;
  process.stdout.write(wrapForTmux(seq));
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: two-part notification (id + title, then body payload)
  const titleSeq = `${ESC}]99;i=1:d=0;${title}${ST}`;
  const bodySeq = `${ESC}]99;i=1:p=body;${body}${ST}`;
  process.stdout.write(wrapForTmux(titleSeq));
  process.stdout.write(wrapForTmux(bodySeq));
}

// ── Support detection (minimal env-var heuristic; no overcomplication) ──

const UNSUPPORTED_MESSAGE =
  "Notifications via OSC not supported in this terminal. " +
  "Please file an issue at https://github.com/jmcombs/pi-extensions/issues";

function isUnsupportedTerminal(): boolean {
  // Explicitly known non-supporting terminals / environments.
  // We dropped all child_process / OS-binary paths (osascript, notify-send, powershell toast).
  if (process.platform === "win32" && !process.env.WT_SESSION) {
    return true;
  }
  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (termProgram === "Apple_Terminal") {
    return true;
  }
  const term = (process.env.TERM ?? "").toLowerCase();
  if (term.includes("alacritty")) {
    return true;
  }
  return false;
}

function getSender(): ((title: string, body: string) => void) | null {
  if (isUnsupportedTerminal()) return null;

  if (process.env.KITTY_WINDOW_ID) {
    return notifyOSC99;
  }

  // Ghostty supports OSC 9 for desktop notifications (not OSC 777).
  const isGhostty = process.env.TERM_PROGRAM === "ghostty";
  if (isGhostty) {
    return (title, body) => {
      notifyOSC9(`${title}: ${body}`);
    };
  }

  const isIterm = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);
  if (isIterm) {
    return (title, body) => {
      notifyOSC9(`${title}: ${body}`);
    };
  }

  // Default to OSC 777 (WezTerm, rxvt-unicode, most modern terminals
  // that adopted the urxvt protocol; tmux passthrough is handled inside wrap).
  return notifyOSC777;
}

function sendNotification(title: string, message: string, ctx: ExtensionContext): void {
  const sender = getSender();
  if (!sender) {
    ctx.ui.notify(UNSUPPORTED_MESSAGE, "info");
    return;
  }

  sender(title, message);
}

// ── Run tracking ───────────────────────────────────────────────────────

interface RunStats {
  turns: number;
  toolCalls: number;
  errors: number;
  toolNames: Set<string>;
}

function freshStats(): RunStats {
  return { turns: 0, toolCalls: 0, errors: 0, toolNames: new Set() };
}

function formatAgentEndMessage(stats: RunStats): string {
  const emoji = stats.errors > 0 ? "❌" : "✅";
  const parts: string[] = [];

  if (stats.turns === 1) {
    parts.push("1 turn");
  } else if (stats.turns > 1) {
    parts.push(`${String(stats.turns)} turns`);
  }

  if (stats.toolCalls > 0) {
    const uniqueCount = stats.toolNames.size;
    parts.push(
      `${String(stats.toolCalls)} tool ${stats.toolCalls === 1 ? "call" : "calls"} (${String(uniqueCount)} unique)`,
    );
  }

  if (stats.errors > 0) {
    parts.push(`${String(stats.errors)} ${stats.errors === 1 ? "error" : "errors"}`);
  }

  const summary = parts.length > 0 ? parts.join(", ") : "no tool calls";
  return `${emoji} Done — ${summary}`;
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const TITLE = "Pi";
  let stats = freshStats();

  pi.on("agent_start", () => {
    stats = freshStats();
  });

  pi.on("turn_end", () => {
    stats.turns++;
  });

  pi.on("tool_execution_end", (event) => {
    stats.toolCalls++;
    stats.toolNames.add(event.toolName);
    if (event.isError) {
      stats.errors++;
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    sendNotification(TITLE, formatAgentEndMessage(stats), ctx);
  });

  pi.registerCommand("notify", {
    description: "Send a test terminal notification via OSC (Ghostty, iTerm2, Kitty, etc.).",
    handler: (args, ctx) => {
      const message = args.trim() || "Waiting for your input";
      sendNotification(TITLE, `🔔 ${message}`, ctx);
      return Promise.resolve();
    },
  });
}
