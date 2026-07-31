/**
 * Runs the dashboard without Pi.
 *
 *   npx tsx packages/steward/scripts/dev.ts
 *
 * Set `STEWARD_PORT` to bind somewhere other than the default.
 *
 * By default every panel is simulated. Set `STEWARD_SOURCE=llama` to drive the
 * CONFIG, MODELS and SLOTS panels (and load/unload) from a real `llama-server`
 * instead, reading `LLAMA_BASE_URL` and `LLAMA_API_KEY` from the environment
 * (there is no Pi provider auth here). The rest of the dashboard stays
 * simulated, and a server that is down or key-gated degrades those panels
 * rather than the whole page.
 *
 * The log console follows the real server too, from `STEWARD_LOG_FILE` or the
 * platform's conventional path. This script reads no `steward.json` — the
 * config-driven seams (host metrics, service control, drift) stay out on
 * purpose — so with neither of those present the console keeps showing the
 * simulated stream.
 */

import type { StewardDataSource } from "../core/source.js";
import { createStewardServer, DEFAULT_PORT } from "../server/index.js";

/**
 * The same live source the extension builds, including the `steward.json`
 * wiring. This used to skip that wiring, so the dev dashboard showed live models
 * beside a simulated host band and no service controls — a half-real view that
 * looked entirely real.
 */
async function buildSource(): Promise<StewardDataSource | undefined> {
  const { resolveLlamaConnection } = await import("../core/llama-connection.js");
  const { LlamaSource } = await import("../core/llama-source.js");
  const { createDisconnectedSource } = await import("../core/disconnected-source.js");
  const { createListenerProbe } = await import("../server/service-probe.js");
  const { createConfigWiring } = await import("../server/config-wiring.js");
  const connection = await resolveLlamaConnection();
  const wiring = createConfigWiring();
  return new LlamaSource({
    connection,
    fallback: createDisconnectedSource(),
    probeService: createListenerProbe(),
    ...wiring.parts,
    rewire: wiring.rewire,
  });
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
