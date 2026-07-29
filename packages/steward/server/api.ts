/**
 * The JSON and SSE routes.
 *
 * The browser polls `/api/snapshot` for everything it repaints and holds one
 * `/api/logs/stream` connection open for the console. Actions are POSTs that
 * return no body — the client re-polls rather than trusting an optimistic
 * result, because a load or a restart can take tens of seconds and can fail.
 *
 * Every route reads and writes through the {@link StewardDataSource} it is
 * given; nothing here knows whether that source is simulated or live.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { StewardDataSource } from "../core/source.js";
import type { LogLine, LogStreamStatus, ModelAction, ServiceAction } from "../core/types.js";

/** Lines replayed to a client that connects mid-run, matching the UI's buffer. */
const BACKLOG_LINES = 200;

/**
 * How often the stream re-reads the source's health.
 *
 * Source state is not a line and cannot ride the line stream: a source that has
 * nothing to say is exactly the case the console has to report on. The file can
 * also vanish mid-session (macOS unlinks `/tmp` files untouched for three days)
 * and come back on its own, so it is polled rather than sent once at open.
 */
const SOURCE_POLL_MS = 2000;

function isServiceAction(value: string): value is ServiceAction {
  return value === "start" || value === "stop" || value === "restart";
}

function isModelAction(value: string): value is ModelAction {
  return value === "load" || value === "unload";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendStatus(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
}

/**
 * Opens the log stream: the buffered backlog first, as individual events, then
 * every line as it arrives. The subscription is released when the client goes
 * away — a browser that reloads must not leave a listener behind.
 */
function streamLogs(req: IncomingMessage, res: ServerResponse, source: StewardDataSource): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // Log lines are small and latency matters more than packet count here.
  req.socket.setNoDelay(true);

  /** Set once the socket is gone, which the guard alone cannot see in time. */
  let gone = false;
  /**
   * Set while the client is behind. Lines that arrive then are dropped rather
   * than queued: this is a live tail, and an unbounded write buffer would cost
   * the server memory to deliver a backlog no operator is reading. The gap is
   * visible in the sequence numbers, which is the honest outcome.
   */
  let saturated = false;

  const write = (frame: string): void => {
    if (gone || res.writableEnded || res.destroyed) return;
    // The socket can end between that guard and this write — a race the
    // stream cannot avoid, only absorb.
    const flushed = res.write(frame, (error) => {
      if (error) gone = true;
    });
    if (!flushed) saturated = true;
  };

  const send = (line: LogLine): void => {
    if (saturated) return;
    write(`data: ${JSON.stringify(line)}\n\n`);
  };

  /**
   * Source health, on its own named event so a `message` listener never sees
   * it. Sent on open and again only when it CHANGES — a console that re-heard
   * "the file is gone" every two seconds would announce it every two seconds.
   *
   * A saturated socket does not suppress this one: it is a handful of bytes and
   * the state it carries is exactly what an operator needs when things are
   * going wrong.
   */
  let lastStatus = "";
  const sendStatusFrame = (): void => {
    const read = source.logStatus;
    if (read === undefined) return;
    let status: LogStreamStatus;
    try {
      status = read.call(source);
    } catch {
      // A source that cannot report on itself is not a reason to drop the tail.
      return;
    }
    const encoded = JSON.stringify(status);
    if (encoded === lastStatus) return;
    lastStatus = encoded;
    write(`event: source\ndata: ${encoded}\n\n`);
  };

  res.on("drain", () => {
    saturated = false;
  });
  res.on("error", () => {
    gone = true;
  });

  // Backlog and subscription are taken together, so a line that arrives while
  // the stream is opening lands in one of them rather than neither. Sources that
  // predate `attachLogs` fall back to the two calls, which are safe only because
  // nothing awaits between them — do not insert one here.
  const attach = source.attachLogs;
  const attached =
    attach === undefined
      ? { backlog: source.recentLogs(BACKLOG_LINES), unsubscribe: source.subscribeLogs(send) }
      : attach.call(source, send, BACKLOG_LINES);

  // Health first, so a client that opens onto an unavailable source knows it
  // before it has read a single (simulated) line.
  sendStatusFrame();
  for (const line of attached.backlog) send(line);

  const statusTimer = setInterval(sendStatusFrame, SOURCE_POLL_MS);
  statusTimer.unref?.();

  res.on("close", () => {
    gone = true;
    clearInterval(statusTimer);
    attached.unsubscribe();
    res.end();
  });
}

/**
 * Handles `/api/**`, returning `false` when the request is not one of these
 * routes so the caller can fall through to the asset route (and, failing that,
 * a 404).
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: StewardDataSource,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/snapshot") {
    sendJson(res, 200, await source.snapshot());
    return true;
  }

  if (method === "GET" && pathname === "/api/logs/stream") {
    streamLogs(req, res, source);
    return true;
  }

  if (method === "POST") {
    const service = /^\/api\/service\/([^/]+)$/.exec(pathname);
    if (service !== null) {
      const action = decodeURIComponent(service[1] ?? "");
      if (!isServiceAction(action)) {
        sendStatus(res, 400);
        return true;
      }
      try {
        await source.setService(action);
      } catch (error) {
        // A control command that was refused is the operator's business, not a
        // crash: the reason ("launchctl: permission denied") goes back as a
        // body so the dashboard can show it inline instead of a bare 500.
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
      sendStatus(res, 204);
      return true;
    }

    const model = /^\/api\/models\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (model !== null) {
      const modelId = decodeURIComponent(model[1] ?? "");
      const action = decodeURIComponent(model[2] ?? "");
      if (!isModelAction(action)) {
        sendStatus(res, 400);
        return true;
      }
      const snapshot = await source.snapshot();
      if (!snapshot.models.some((entry) => entry.id === modelId)) {
        sendStatus(res, 404);
        return true;
      }
      await source.setModel(modelId, action);
      sendStatus(res, 204);
      return true;
    }
  }

  return false;
}
