/**
 * @jmcombs/pi-notify — OS-level desktop notifications for Pi.
 *
 * Sends a native OS notification when the agent finishes a turn and is
 * waiting for user input. Uses only Node.js built-ins and OS-native tools:
 *   - macOS:   osascript  (ships with every macOS; works in any terminal)
 *   - Linux:   notify-send (libnotify; present on any desktop environment)
 *   - Windows: not supported in v1; degrades silently to TUI notification
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ── Platform delivery ──────────────────────────────────────────────────

async function sendMacOS(title: string, message: string): Promise<void> {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await execFileAsync("osascript", ["-e", script]);
}

async function sendLinux(title: string, message: string): Promise<void> {
  await execFileAsync("notify-send", [title, message]);
}

async function sendNotification(
  title: string,
  message: string,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await sendMacOS(title, message);
    } else if (process.platform === "linux") {
      await sendLinux(title, message);
    } else {
      ctx.ui.notify(message, "info");
    }
  } catch {
    ctx.ui.notify(message, "info");
  }
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const TITLE = "Pi";
  const DEFAULT_MESSAGE = "Waiting for your input";

  pi.on("agent_end", async (_event, ctx) => {
    await sendNotification(TITLE, DEFAULT_MESSAGE, ctx);
  });

  pi.registerCommand("notify", {
    description: "Send a test OS notification (macOS and Linux only).",
    handler: async (args, ctx) => {
      const message = args.trim() || DEFAULT_MESSAGE;
      await sendNotification(TITLE, message, ctx);
    },
  });
}
