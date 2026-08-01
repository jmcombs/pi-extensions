/**
 * @jmcombs/pi-steward — Steward, the llama.cpp control panel for Pi.
 *
 * Steward is a single-page operator dashboard for the local `llama-server`
 * that backs Pi's llama.cpp provider. It answers four questions at a glance —
 * is the service up, which models are resident, is the box healthy, and what
 * is the server doing right now — and lets the operator act on all of them
 * without a terminal.
 *
 * This file is the extension's entry point. Pi loads it via jiti, so
 * TypeScript works without a build step. `/steward_start` brings up a loopback
 * server for the session, `/steward_dashboard` opens it in a browser (starting it
 * if needed), and `/steward_stop` shuts it down — as does the end of the session.
 * `/steward_initialize` connects the machine in the first place. `STEWARD_PORT` chooses the port; a port that
 * is already taken costs an ephemeral one, not the dashboard.
 *
 * See:
 *   - CONTRIBUTING.md (project conventions)
 *   - TEMPLATE.md at the repo root (how this package was scaffolded)
 *   - https://pi.dev/docs/extensions
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConnectionContext } from "./core/llama-connection.js";
import type { StewardDataSource } from "./core/source.js";
import type { StewardServer } from "./server/index.js";
import { buildInitPrompt, setupScriptPath } from "./setup/init-prompt.js";

/**
 * The environment variable that moves the dashboard off its default port,
 * matching `scripts/dev.ts`. `0` asks the OS for any free port.
 */
const PORT_VARIABLE = "STEWARD_PORT";

/** The dashboard is per-session: one server, started on first use. */
let server: StewardServer | null = null;
/**
 * Starts and stops run one at a time on this chain. Two quick `/steward_start`
 * invocations then share one server rather than binding twice, and a
 * `/steward_stop` or a session shutdown that lands mid-start stops the server
 * that start produced instead of missing it.
 */
let queue: Promise<void> = Promise.resolve();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enqueue<T>(step: () => Promise<T>): Promise<T> {
  const next = queue.then(step);
  // One failed step must not poison the chain for the next command.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "EADDRINUSE";
}

/**
 * The port the operator asked for, or `null` when they did not. Throws on a
 * value that is set but unusable, rather than quietly binding somewhere else.
 */
function configuredPort(): number | null {
  const raw = process.env[PORT_VARIABLE];
  if (raw === undefined || raw.trim() === "") return null;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${PORT_VARIABLE}=${raw} is not a port number between 0 and 65535`);
  }
  return port;
}

interface Dashboard {
  url: string;
  /** The preferred port, when it was taken and the server landed elsewhere. */
  displaced: number | null;
}

interface Launched extends Dashboard {
  instance: StewardServer;
}

/** Builds one fresh source, or `undefined` to let the server use its mock. */
type SourceFactory = () => StewardDataSource;

/**
 * A factory for the live source. Building it needs the connection, which we
 * resolve once from the command's context — inside Pi that reads the operator's
 * configured provider auth. Everything is imported lazily so the extension costs
 * nothing until the dashboard is actually asked for.
 *
 * Unconditional on purpose. This used to be gated behind `STEWARD_SOURCE=llama`,
 * which made the config wiring below unreachable unless the operator had opted
 * in *before* the machine was configured — so `/steward_initialize` followed by
 * `/steward_dashboard` in the same session showed a simulated dashboard, and only a fresh
 * Pi session ever showed the machine. The gate defeated the exact feature the
 * wiring exists to provide.
 *
 * A machine with nothing to read is not a reason to invent one: panels that
 * cannot be filled report themselves disconnected.
 */
async function sourceFactory(ctx: ConnectionContext): Promise<SourceFactory | undefined> {
  const { resolveLlamaConnection } = await import("./core/llama-connection.js");
  const { LlamaSource } = await import("./core/llama-source.js");
  const { createDisconnectedSource } = await import("./core/disconnected-source.js");
  const { createListenerProbe } = await import("./server/service-probe.js");
  const { createConfigWiring } = await import("./server/config-wiring.js");
  // Read the artifact before resolving the connection: its baseUrl decides
  // which server Steward watches, and the resolver needs it up front.
  const { readStewardConfig } = await import("./server/steward-config.js");
  const recorded = readStewardConfig();
  const connection = await resolveLlamaConnection(ctx, process.env, recorded?.baseUrl ?? null);
  const probeService = createListenerProbe();

  return () => {
    // Everything `steward.json` decides — the host collector, the service
    // control commands, the drift baseline, the log tail — comes from the
    // wiring, which reads the artifact now and keeps reading it as it changes.
    // That is what lets an operator run `/steward_initialize` with the dashboard
    // already open: the panels wire themselves up on the next repaint instead of
    // waiting for a new Pi session, and a config that is deleted takes its
    // collector and its buttons with it.
    //
    // A fresh wiring per source, for the same reason the collector was always
    // built per source: a start that fails to bind closes the source it was
    // handed (killing its collector and stopping its watcher), so a retry must
    // not reuse a spent one.
    const wiring = createConfigWiring();
    return new LlamaSource({
      connection,
      fallback: createDisconnectedSource(),
      probeService,
      ...wiring.parts,
      rewire: wiring.rewire,
    });
  };
}

async function launch(makeSource?: SourceFactory): Promise<Launched> {
  // Imported lazily so loading the extension costs nothing until the dashboard
  // is actually asked for.
  const { createStewardServer, DEFAULT_PORT } = await import("./server/index.js");
  const preferred = configuredPort() ?? DEFAULT_PORT;

  // A fresh source per attempt: a start that fails to bind closes the source it
  // was given, so the fallback attempt must not be handed a spent one.
  const first = createStewardServer({ port: preferred, source: makeSource?.() });
  try {
    return { instance: first, url: await first.start(), displaced: null };
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
  }

  // A particular port is a convenience, not a requirement: a second Pi session
  // or a dev server left running holds it far more often than anything is
  // actually wrong, and the operator gets a URL either way.
  const fallback = createStewardServer({ port: 0, source: makeSource?.() });
  try {
    return { instance: fallback, url: await fallback.start(), displaced: preferred };
  } catch (error) {
    throw new Error(
      `port ${preferred} is in use and no other port could be bound (${describe(error)})`,
    );
  }
}

function ensureServer(ctx: ConnectionContext): Promise<Dashboard> {
  return enqueue(async () => {
    const running = server;
    if (running !== null && running.url !== null) return { url: running.url, displaced: null };

    // Resolve the source inside the queued step, not before it: enqueueing must
    // stay synchronous so a concurrent `/steward_stop` chains behind this start
    // rather than racing ahead of it.
    const launched = await launch(await sourceFactory(ctx));
    server = launched.instance;
    return { url: launched.url, displaced: launched.displaced };
  });
}

/** Resolves `true` when there was a server to stop, `false` when there was not. */
function stopServer(): Promise<boolean> {
  return enqueue(async () => {
    const instance = server;
    server = null;
    if (instance === null) return false;
    await instance.stop();
    return true;
  });
}

/** Hands the URL to the platform's opener. Rejects if the opener cannot run. */
function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  // `start` is a shell builtin on Windows, and its first argument is the
  // window title — hence the empty string before the URL.
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export default function (pi: ExtensionAPI): void {
  // Starting the server and opening a browser are separate commands: an
  // operator on a headless box, or one who just wants the widget live, has no
  // use for a browser, and someone whose tab is closed should not have to stop
  // and restart the server to get it back.
  pi.registerCommand("steward_start", {
    description: "Start the Steward dashboard service.",
    handler: async (_args, ctx) => {
      let dashboard: Dashboard;
      try {
        dashboard = await ensureServer(ctx);
      } catch (error) {
        ctx.ui.notify(`Steward could not start: ${describe(error)}`, "error");
        return;
      }
      const where =
        dashboard.displaced === null
          ? `Steward is serving at ${dashboard.url}`
          : `Steward is serving at ${dashboard.url} — port ${dashboard.displaced} was already in use`;
      ctx.ui.notify(`${where}. Open it with /steward_dashboard.`, "info");
      void refreshWidget(ctx);
    },
  });

  pi.registerCommand("steward_dashboard", {
    description: "Open the Steward dashboard in your browser, starting it if needed.",
    handler: async (_args, ctx) => {
      let dashboard: Dashboard;
      try {
        dashboard = await ensureServer(ctx);
      } catch (error) {
        ctx.ui.notify(`Steward could not start: ${describe(error)}`, "error");
        return;
      }

      const where =
        dashboard.displaced === null
          ? `Steward is serving at ${dashboard.url}`
          : `Steward is serving at ${dashboard.url} — port ${dashboard.displaced} was already in use`;
      // The URL goes out before the browser is touched, so a headless or
      // locked-down environment still gets something it can act on.
      ctx.ui.notify(where, "info");
      try {
        await openInBrowser(dashboard.url);
        void refreshWidget(ctx);
      } catch (error) {
        ctx.ui.notify(`Steward could not open a browser (${describe(error)})`, "warning");
      }
    },
  });

  pi.registerCommand("steward_stop", {
    description: "Stop the Steward dashboard server.",
    handler: async (_args, ctx) => {
      try {
        // Asked inside the queue, not before it: a start still in flight owns
        // a server this stop is responsible for, and the answer is only true
        // once that start has settled.
        const stopped = await stopServer();
        ctx.ui.notify(stopped ? "Steward stopped." : "Steward is not running.", "info");
        void refreshWidget(ctx);
      } catch (error) {
        ctx.ui.notify(`Steward could not stop cleanly: ${describe(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("steward_initialize", {
    description:
      "Connect this machine to Steward — review the local llama.cpp setup and propose the configuration it needs.",
    handler: async (_args, ctx) => {
      // Delivered as a message rather than a prompt template because the
      // helper's absolute path is only knowable at runtime: the package can be
      // installed anywhere, and templates substitute positional arguments only.
      // `display: false` keeps the instructions out of the transcript — they are
      // a brief for the model, not something the operator needs to read back.
      if (typeof pi.sendMessage !== "function") {
        ctx.ui.notify(
          "This Pi host cannot deliver the setup brief (sendMessage is unavailable).",
          "error",
        );
        return;
      }
      pi.sendMessage(
        {
          customType: "steward-initialize",
          content: buildInitPrompt(setupScriptPath()),
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });

  // The footer chip. Refreshed at the two moments the operator's eyes are on it
  // — session start, and the end of each turn — rather than on a timer: a timer
  // probes a machine nobody is looking at and can repaint mid-stream. A reading
  // that is a turn old is fine; one that costs a permanent poll is not.
  //
  // Guarded on `hasUI` and on the method itself: Pi runs headless, and oh-my-pi
  // ships a subset shim, so the commands must keep working with no chip.
  const STATUS_WIDGET_KEY = "steward-status";
  let widgetInFlight = false;
  const refreshWidget = async (ctx: ExtensionContext): Promise<void> => {
    // Feature-detected, not gated on `hasUI`. `session_start` is emitted from
    // `bindExtensions` during startup, when the TUI may not have come up yet and
    // `hasUI` is still false — gating on it meant the chip did not appear until
    // the first turn ended. Setting a status headless is harmless: nothing
    // renders it.
    if (typeof ctx.ui?.setWidget !== "function") return;
    if (widgetInFlight) return;
    widgetInFlight = true;
    try {
      const { formatStatusWidget, resolveGlyph } = await import("./core/status-widget.js");
      const { readStewardConfig } = await import("./server/steward-config.js");
      const { resolveLlamaConnection } = await import("./core/llama-connection.js");
      const glyph = resolveGlyph(process.env);

      // Steward's own state costs nothing: the extension holds the server.
      const portalUrl = server?.url ?? null;
      const recorded = readStewardConfig();
      const stewardBaseUrl = recorded?.baseUrl ?? null;
      // Where Pi would send a chat, ignoring what Steward was told. Passing
      // `null` deliberately bypasses the recorded URL so the two can be compared
      // — a router Pi cannot reach is the failure the orange state is for.
      const provider = await resolveLlamaConnection(
        ctx as unknown as ConnectionContext,
        process.env,
        null,
      );

      // Only read the machine when the dashboard is up; a stopped Steward has
      // nothing to say about llama.cpp and should not pay for a probe.
      let snapshot = null;
      if (portalUrl !== null) {
        const make = await sourceFactory(ctx as unknown as ConnectionContext);
        const source = make?.();
        try {
          snapshot = source === undefined ? null : await source.snapshot();
        } finally {
          source?.close();
        }
      }

      const line = formatStatusWidget(
        { portalUrl, snapshot, providerBaseUrl: provider.baseUrl, stewardBaseUrl },
        glyph,
      );
      ctx.ui.setWidget(STATUS_WIDGET_KEY, [line], { placement: "aboveEditor" });
    } catch {
      // Informational only: never let it disturb the loop. The previous line
      // stays on screen rather than being cleared to nothing.
    } finally {
      widgetInFlight = false;
    }
  };

  // `on` is not part of every host's extension API — oh-my-pi ships a subset
  // shim — so it is feature-detected rather than assumed. Without it the
  // server simply outlives the session until the process exits.
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      await refreshWidget(ctx);
    });
    // Also on turn START: if the chip missed its first chance at session_start
    // — a TUI that was not up yet, a probe that lost a race — this is the next
    // moment the operator looks at the footer, and it costs one loopback read.
    pi.on("turn_start", async (_event, ctx) => {
      await refreshWidget(ctx);
    });
    pi.on("turn_end", async (_event, ctx) => {
      await refreshWidget(ctx);
    });
    pi.on("session_shutdown", async () => {
      await stopServer();
    });
  }
}
