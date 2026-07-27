/**
 * Runs the dashboard without Pi.
 *
 *   npx tsx packages/steward/scripts/dev.ts
 *
 * Set `STEWARD_PORT` to bind somewhere other than the default.
 *
 * By default every panel is simulated. Set `STEWARD_SOURCE=llama` to drive the
 * CONFIG panel from a real `llama-server` instead, reading `LLAMA_BASE_URL` and
 * `LLAMA_API_KEY` from the environment (there is no Pi provider auth here). The
 * rest of the dashboard stays simulated, and a server that is down or key-gated
 * degrades CONFIG rather than the whole page.
 */

import type { StewardDataSource } from "../core/source.js";
import { createStewardServer, DEFAULT_PORT } from "../server/index.js";

async function buildSource(): Promise<StewardDataSource | undefined> {
  if ((process.env.STEWARD_SOURCE ?? "").trim().toLowerCase() !== "llama") return undefined;
  const { resolveLlamaConnection } = await import("../core/llama-connection.js");
  const { LlamaConfigSource } = await import("../core/llama-source.js");
  const { createMockSource } = await import("../core/mock-source.js");
  const connection = await resolveLlamaConnection();
  return new LlamaConfigSource({ connection, fallback: createMockSource() });
}

const port = Number.parseInt(process.env.STEWARD_PORT ?? "", 10);
const source = await buildSource();
const server = createStewardServer({ port: Number.isNaN(port) ? DEFAULT_PORT : port, source });

const url = await server.start();
console.log(`Steward is serving at ${url} — Ctrl-C to stop.`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
