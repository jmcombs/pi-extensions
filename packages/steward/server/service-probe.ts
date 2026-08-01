/**
 * Resolves the local process serving a host:port, for the SERVICE panel's real
 * pid and uptime — facts `llama-server` does not report over HTTP.
 *
 * It shells out to `lsof` (the listener's pid) and `ps` (its start time), so it
 * is macOS/Linux only and best-effort: anything it cannot determine degrades to
 * n/a, never an error. This is exactly why it is injected into the otherwise
 * Node-free {@link LlamaSource} rather than living in `core/`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceProbe, ServiceProcess } from "../core/llama-source.js";

const run = promisify(execFile);

/** No single probe command may hang the metrics poll. */
const PROBE_TIMEOUT_MS = 1500;

/** The first pid listening on the TCP port, or null when none is found. */
async function listenerPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    for (const line of stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  } catch {
    // lsof missing, no match (exit 1), or timed out: no pid to report.
    return null;
  }
}

/** A process's start time as epoch ms, or null when it cannot be read. */
async function startedAt(pid: number): Promise<number | null> {
  try {
    // `ps -o lstart=` prints an absolute, locale-parseable timestamp on both
    // macOS and Linux (unlike `etimes`, which is Linux-only).
    const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * A probe with a per-pid start-time cache: the listener pid is cheap to re-read
 * each snapshot, but a process's start time never changes, so `ps` runs once per
 * pid rather than on every poll. A new (or absent) pid drops the cache.
 */
export function createListenerProbe(): ServiceProbe {
  const startCache = new Map<number, number | null>();
  return async (_host: string, port: number): Promise<ServiceProcess | null> => {
    const pid = await listenerPid(port);
    if (pid === null) {
      startCache.clear();
      return null;
    }
    if (!startCache.has(pid)) {
      startCache.clear();
      startCache.set(pid, await startedAt(pid));
    }
    return { pid, startedAt: startCache.get(pid) ?? null };
  };
}
