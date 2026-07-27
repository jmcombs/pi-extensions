/**
 * Runs the dashboard against the simulated source, without Pi.
 *
 *   npx tsx packages/steward/scripts/dev.ts
 *
 * Set `STEWARD_PORT` to bind somewhere other than the default.
 */

import { createStewardServer, DEFAULT_PORT } from "../server/index.js";

const port = Number.parseInt(process.env.STEWARD_PORT ?? "", 10);
const server = createStewardServer({ port: Number.isNaN(port) ? DEFAULT_PORT : port });

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
