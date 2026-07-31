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
 * TypeScript works without a build step. `/steward` starts a loopback server
 * for the session and opens it in the browser; `/steward-stop` shuts it down,
 * as does the end of the session. `STEWARD_PORT` chooses the port; a port that
 * is already taken costs an ephemeral one, not the dashboard.
 *
 * See:
 *   - CONTRIBUTING.md (project conventions)
 *   - TEMPLATE.md at the repo root (how this package was scaffolded)
 *   - https://pi.dev/docs/extensions
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConnectionContext } from "./core/llama-connection.js";
import type { StewardDataSource } from "./core/source.js";
import type { StewardServer } from "./server/index.js";

/**
 * The environment variable that moves the dashboard off its default port,
 * matching `scripts/dev.ts`. `0` asks the OS for any free port.
 */
const PORT_VARIABLE = "STEWARD_PORT";

/**
 * Selects the data source. Unset or `mock` keeps the simulated dashboard (the
 * default, so everyone gets a deterministic view). `llama` overlays the live
 * CONFIG, SERVICE, MODELS and SLOTS panels read from the real `llama-server`,
 * while the rest stay simulated for now. Live is opt-in until the whole
 * snapshot is migrated.
 */
const SOURCE_VARIABLE = "STEWARD_SOURCE";

/** The dashboard is per-session: one server, started on first use. */
let server: StewardServer | null = null;
/**
 * Starts and stops run one at a time on this chain. Two quick `/steward`
 * invocations then share one server rather than binding twice, and a
 * `/steward-stop` or a session shutdown that lands mid-start stops the server
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
 * A factory for the live source when `STEWARD_SOURCE=llama`, else `undefined`
 * (the mock default). Building it needs the connection, which we resolve once
 * from the command's context — inside Pi that reads the operator's configured
 * provider auth; the factory then pairs a live CONFIG/MODELS/SLOTS reader with a
 * fresh mock for every other panel. Everything is imported lazily so the
 * extension costs nothing until the dashboard is actually asked for.
 */
async function sourceFactory(ctx: ConnectionContext): Promise<SourceFactory | undefined> {
  if ((process.env[SOURCE_VARIABLE] ?? "").trim().toLowerCase() !== "llama") return undefined;
  const { resolveLlamaConnection } = await import("./core/llama-connection.js");
  const { LlamaSource } = await import("./core/llama-source.js");
  const { createMockSource } = await import("./core/mock-source.js");
  const { createListenerProbe } = await import("./server/service-probe.js");
  const { createConfigWiring } = await import("./server/config-wiring.js");
  const connection = await resolveLlamaConnection(ctx);
  const probeService = createListenerProbe();

  return () => {
    // Everything `steward.json` decides — the host collector, the service
    // control commands, the drift baseline, the log tail — comes from the
    // wiring, which reads the artifact now and keeps reading it as it changes.
    // That is what lets an operator run `/initialize-steward` with the dashboard
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
      fallback: createMockSource(),
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
    // stay synchronous so a concurrent `/steward-stop` chains behind this start
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
  pi.registerCommand("steward", {
    description: "Open the Steward dashboard for the local llama.cpp server.",
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
      } catch (error) {
        ctx.ui.notify(`Steward could not open a browser (${describe(error)})`, "warning");
      }
    },
  });

  pi.registerCommand("steward-stop", {
    description: "Stop the Steward dashboard server.",
    handler: async (_args, ctx) => {
      try {
        // Asked inside the queue, not before it: a start still in flight owns
        // a server this stop is responsible for, and the answer is only true
        // once that start has settled.
        const stopped = await stopServer();
        ctx.ui.notify(stopped ? "Steward stopped." : "Steward is not running.", "info");
      } catch (error) {
        ctx.ui.notify(`Steward could not stop cleanly: ${describe(error)}`, "warning");
      }
    },
  });

  // `on` is not part of every host's extension API — oh-my-pi ships a subset
  // shim — so it is feature-detected rather than assumed. Without it the
  // server simply outlives the session until the process exits.
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", async () => {
      await stopServer();
    });
  }
}
