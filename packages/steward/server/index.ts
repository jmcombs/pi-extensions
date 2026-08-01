/**
 * The Steward server.
 *
 * A `node:http` server bound to loopback that does two things: serve the
 * dashboard's own files (see `./assets.ts`) and expose one
 * {@link StewardDataSource} over HTTP (see `./api.ts`). It holds the single
 * source instance for the process, which is why swapping the mock for a live
 * `llama-server` reader is a change here and nowhere else.
 *
 * It is never exposed beyond `127.0.0.1`: it can start and stop a local
 * service and has no authentication of its own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createDisconnectedSource } from "../core/disconnected-source.js";
import type { StewardDataSource } from "../core/source.js";
import { handleApiRequest } from "./api.js";
import { assertTypeStripping, readAsset } from "./assets.js";

/** The port Steward asks for unless told otherwise. */
export const DEFAULT_PORT = 8788;

/** Loopback only, deliberately: see the module comment. */
const HOST = "127.0.0.1";

export interface StewardServerOptions {
  /** Port to bind. `0` picks a free one, which {@link StewardServer.port} reports. */
  port?: number;
  /**
   * The source to serve. Defaults to the simulated one, which is built on the
   * first {@link StewardServer.start} rather than here, so a server that never
   * binds never starts a simulation. The server takes ownership either way: it
   * closes the source when it stops, and when a start fails.
   */
  source?: StewardDataSource;
}

export interface StewardServer {
  /**
   * Binds the socket and resolves with the URL to open, port included.
   * Resolves with the same URL if it is already bound, and joins an in-flight
   * start rather than binding twice.
   *
   * A start that fails releases everything it created, which includes closing
   * the data source — so a rejected start, like {@link StewardServer.stop},
   * spends the instance. Calling `start` on a spent instance rejects.
   */
  start(): Promise<string>;
  /**
   * Closes live connections, the socket, and the data source, waiting for an
   * in-flight {@link StewardServer.start} first so it cannot leave a socket
   * bound behind the stop.
   *
   * Terminal: repeat calls resolve without doing more, and the instance cannot
   * be started again — its source has been closed and closed sources do not
   * come back.
   */
  stop(): Promise<void>;
  /** The bound URL, or `null` before {@link start} resolves. */
  readonly url: string | null;
  /** The bound port, or `null` before {@link start} resolves. */
  readonly port: number | null;
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Closes any connection still open, so `close()` is not held up by an SSE client. */
function closeConnections(server: Server): void {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
}

export function createStewardServer(options: StewardServerOptions = {}): StewardServer {
  const requestedPort = options.port ?? DEFAULT_PORT;

  let source: StewardDataSource | null = options.source ?? null;
  let boundPort: number | null = null;
  let boundUrl: string | null = null;
  /** Set once the instance is spent, by a stop or by a start that failed. */
  let spent = false;
  let starting: Promise<string> | null = null;
  let stopping: Promise<void> | null = null;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Requests only arrive between a resolved start and a stop, so the source
    // is there — but a stop that lands mid-request must not be a crash.
    const active = source;
    if (active === null) {
      sendPlain(res, 503, "Steward is shutting down\n");
      return;
    }

    // The base is a formality: only the path and query of `req.url` are real.
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);

    if (await handleApiRequest(req, res, active, pathname)) return;

    if (req.method === "GET") {
      const asset = await readAsset(pathname);
      if (asset !== null) {
        res.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": Buffer.byteLength(asset.body),
          "Cache-Control": "no-store",
        });
        res.end(asset.body);
        return;
      }
    }

    sendPlain(res, 404, "Not found\n");
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      // The detail goes to the operator's terminal, not to the page: it can
      // name absolute paths, and the browser has no use for it either way.
      console.error(`[steward] ${req.method ?? "GET"} ${req.url ?? "/"} failed: ${detail}`);
      if (!res.headersSent) sendPlain(res, 500, "Internal error\n");
      else res.end();
    });
  });

  /** Releases every resource the instance holds. Safe to call more than once. */
  function release(): Promise<void> {
    const active = source;
    source = null;
    boundUrl = null;
    boundPort = null;
    if (active !== null) active.close();
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      closeConnections(server);
    });
  }

  function bind(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Every browser module is type-stripped on demand, so a runtime that
      // cannot strip serves the shell and nothing that makes it work. Fail
      // here, where whoever asked for the dashboard is still listening.
      assertTypeStripping();
      source = source ?? createDisconnectedSource();

      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Steward server bound to an unexpected address"));
          return;
        }
        boundPort = address.port;
        boundUrl = `http://${HOST}:${address.port}`;
        resolve(boundUrl);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, HOST);
    });
  }

  return {
    get url(): string | null {
      return boundUrl;
    },

    get port(): number | null {
      return boundPort;
    },

    start(): Promise<string> {
      if (spent) {
        return Promise.reject(
          new Error("Steward server is spent: start a new one rather than reviving this one"),
        );
      }
      if (boundUrl !== null) return Promise.resolve(boundUrl);
      if (starting !== null) return starting;

      const attempt = bind().then(
        (url) => {
          starting = null;
          return url;
        },
        async (error: unknown) => {
          // A start owns everything it built, whether or not it got as far as
          // binding: the source's tickers are running by now and only this
          // path can still reach them.
          starting = null;
          spent = true;
          await release();
          throw error;
        },
      );
      starting = attempt;
      return attempt;
    },

    stop(): Promise<void> {
      if (stopping !== null) return stopping;
      spent = true;
      const pending = starting;
      const attempt = (async () => {
        // A stop that lands mid-start must wait for the socket the start is
        // about to bind, or it would close nothing and leave it listening.
        if (pending !== null) await pending.catch(() => undefined);
        await release();
      })();
      stopping = attempt;
      return attempt;
    },
  };
}
