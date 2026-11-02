/**
 * @jmcombs/pi-omlx — omlx provider for Pi.
 *
 * Registers native provider `omlx` and the `/omlx` manager. Chat and
 * classifier catalogs refresh from the server. GGUF models are not supported.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { OmlxClient, type OmlxModelStatus, type OmlxStatusRow } from "./client.js";
import { loadRatio } from "./progress.js";
import { createOmlxProvider, OMLX_PROVIDER_ID } from "./provider.js";
import { managerRows, type OmlxProgress, type OmlxUi, runWithProgress, showOmlxUi } from "./ui.js";
import { normalizeOmlxServerUrl } from "./url.js";

const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
const LOAD_POLL_MS = 250;

interface CatalogSnapshot {
  status: OmlxModelStatus;
  listed: Awaited<ReturnType<OmlxClient["listModels"]>>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Cancelled");
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    message.includes("fetch failed") || message.includes("timeout") || message.includes("network")
  );
}

function connectionErrorMessage(error: unknown): string {
  if (isConnectionError(error)) return "Could not connect to the server.";
  return errorText(error);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || isConnectionError(error));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `loading_started_at` is the server's monotonic clock. Elapsed since this
 * client started the load is added to that timestamp so `loadRatio` sees one
 * clock. The two clocks agree on elapsed for a load this client started.
 */
function ratioForRow(
  row: OmlxStatusRow,
  status: OmlxModelStatus,
  startedAt: number,
): number | undefined {
  if (row.loading_started_at === null) return undefined;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  return loadRatio(row, status, row.loading_started_at + elapsedSeconds);
}

/**
 * POST load, then poll status until the row is loaded.
 *
 * The POST is not tied to `signal`. Aborting it is not a load cancel, and
 * omlx has no load-cancel route. Aborting `signal` only stops this wait.
 * A client timeout while `is_loading` is still true keeps polling, because
 * the server may still be loading.
 */
async function loadUntilLoaded(
  client: OmlxClient,
  id: string,
  signal: AbortSignal,
  onProgress?: (progress: OmlxProgress) => void,
): Promise<void> {
  const startedAt = performance.now();
  let loadError: unknown;
  let loadSettled: "ok" | "error" | undefined;
  const loadDone = client.load(id).then(
    () => {
      loadSettled = "ok";
    },
    (error: unknown) => {
      loadError = error;
      loadSettled = "error";
    },
  );

  const report = async (): Promise<OmlxStatusRow | undefined> => {
    const status = await client.listStatus(signal);
    const row = status.models.find((model) => model.id === id);
    if (onProgress) {
      onProgress({
        message: "Loading model",
        ratio: row ? ratioForRow(row, status, startedAt) : undefined,
      });
    }
    return row;
  };

  while (!signal.aborted) {
    try {
      if (loadSettled === undefined) {
        await Promise.race([loadDone, wait(LOAD_POLL_MS, signal)]);
      } else {
        await wait(LOAD_POLL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw error;
    }
    if (signal.aborted) throw abortError(signal);
    const row = await report();
    if (row?.loaded && !row.is_loading) return;
    if (loadSettled === "ok") return;
    if (loadSettled === "error" && !(isTimeoutError(loadError) && row?.is_loading)) {
      throw loadError instanceof Error ? loadError : new Error("Model failed to load");
    }
  }
  throw abortError(signal);
}

async function configuredClient(
  ctx: ExtensionCommandContext,
): Promise<{ client: OmlxClient; serverUrl: string } | undefined> {
  const result = await ctx.modelRegistry.getProviderAuth(OMLX_PROVIDER_ID);
  if (!result) {
    ctx.ui.notify(`Configure omlx with /login ${OMLX_PROVIDER_ID}`, "warning");
    return undefined;
  }
  const configuredUrl = result.env?.OMLX_BASE_URL;
  const serverUrl = normalizeOmlxServerUrl(
    typeof configuredUrl === "string" && configuredUrl
      ? configuredUrl
      : (result.auth.baseUrl ?? ""),
  );
  return { client: new OmlxClient(serverUrl, result.auth.apiKey), serverUrl };
}

async function refreshCatalog(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
  const result = await ctx.modelRegistry.refresh({
    providers: [OMLX_PROVIDER_ID],
    allowNetwork: true,
    signal,
  });
  if (result.aborted) throw new Error("Model catalog refresh timed out.");
  const refreshError = result.errors.get(OMLX_PROVIDER_ID);
  if (refreshError) throw refreshError;
}

function cachedContextWindows(ctx: ExtensionCommandContext): Map<string, number> {
  const cached = new Map<string, number>();
  for (const model of ctx.modelRegistry.getAll()) {
    if (model.provider !== OMLX_PROVIDER_ID) continue;
    if (typeof model.contextWindow === "number") cached.set(model.id, model.contextWindow);
  }
  return cached;
}

/**
 * Notice after Esc confirms "Stop loading?".
 *
 * Pi replaces the previous info status on the next info notify. A following
 * "Restoring previously loaded models" line hides this sentence, so restore
 * shares this one notice instead of sending its own.
 */
export function stopWaitingNotice(modelId: string, restoring: boolean): string {
  const stopped = `Stopped waiting for ${modelId}. omlx finishes the load in the background.`;
  if (!restoring) return stopped;
  return `${stopped}\nRestoring previously loaded models.`;
}

/**
 * Stop waiting, tell the user omlx finishes the load, then restore when
 * unload-all already ran. `restore` must not notify: another info notify
 * would replace the stop-waiting notice.
 */
export async function finishStoppedLoad(options: {
  notify: (message: string) => void;
  modelId: string;
  restoring: boolean;
  restore: () => Promise<void>;
}): Promise<void> {
  options.notify(stopWaitingNotice(options.modelId, options.restoring));
  if (options.restoring) await options.restore();
}

async function reloadPreviouslyLoaded(
  client: OmlxClient,
  loaded: readonly OmlxStatusRow[],
): Promise<void> {
  for (const model of loaded) {
    await loadUntilLoaded(client, model.id, new AbortController().signal);
  }
}

async function restoreLoaded(
  ctx: ExtensionCommandContext,
  client: OmlxClient,
  loaded: readonly OmlxStatusRow[],
): Promise<void> {
  ctx.ui.notify("Restoring previously loaded models");
  await reloadPreviouslyLoaded(client, loaded);
}

async function loadModel(
  ctx: ExtensionCommandContext,
  ui: OmlxUi,
  client: OmlxClient,
  catalog: OmlxModelStatus,
  target: OmlxStatusRow,
): Promise<void> {
  const loaded = managerRows(catalog.models).filter(
    (model) => model.id !== target.id && model.loaded && !model.is_loading,
  );
  let replace = false;
  if (loaded.length > 0) {
    const choice = await ui.select(
      `${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`,
      ["Unload all and load", "Keep loaded and load", "Cancel"],
    );
    if (!choice || choice === "Cancel") return;
    replace = choice === "Unload all and load";
  }
  if (replace) {
    for (const model of loaded) await client.unloadAndWait(model.id);
  }
  try {
    const result = await runWithProgress(ui, {
      title: "Loading model",
      model: target.id,
      initialMessage: "Loading model",
      cancelTitle: "Stop loading?",
      cancelMessage: target.id,
      run: (signal, update) => loadUntilLoaded(client, target.id, signal, update),
      // Unload returns 409 while is_loading, and there is no load-cancel route.
      cancel: () => Promise.resolve(),
    });
    if (result.cancelled) {
      await finishStoppedLoad({
        notify: (message) => {
          ctx.ui.notify(message);
        },
        modelId: target.id,
        restoring: replace,
        restore: () => reloadPreviouslyLoaded(client, loaded),
      });
      return;
    }
    ctx.ui.notify(`Loaded ${target.id}`);
  } catch (error) {
    if (replace) {
      try {
        await restoreLoaded(ctx, client, loaded);
      } catch {
        // Preserve the original load error.
      }
    }
    throw error;
  }
}

async function unloadModel(
  ctx: ExtensionCommandContext,
  ui: OmlxUi,
  client: OmlxClient,
  model: OmlxStatusRow,
): Promise<void> {
  if (!(await ui.confirm("Unload model?", model.id))) return;
  await client.unloadAndWait(model.id);
  await refreshCatalog(ctx, AbortSignal.timeout(15_000));
  ctx.ui.notify(`Unloaded ${model.id}`);
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createOmlxProvider().provider);
  pi.registerCommand("omlx", {
    description: "Manage omlx models",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/omlx is available in interactive mode", "warning");
        return;
      }
      const configured = await configuredClient(ctx);
      if (!configured) return;
      const { client, serverUrl } = configured;
      await showOmlxUi(ctx, async (ui) => {
        const readCatalog = async (): Promise<CatalogSnapshot | undefined> => {
          while (true) {
            try {
              const signal = AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS);
              const status = await client.listStatus(signal);
              const listed = await client.listModels(signal);
              await refreshCatalog(ctx, signal);
              return { status, listed };
            } catch (error) {
              if (
                (await ui.connectionError(serverUrl, connectionErrorMessage(error))) === "close"
              ) {
                return undefined;
              }
            }
          }
        };
        let catalog = await readCatalog();
        if (!catalog) return;
        while (true) {
          const action = await ui.showModels(
            serverUrl,
            catalog.status,
            catalog.listed,
            cachedContextWindows(ctx),
          );
          if (action.type === "close") return;
          let actionError: unknown;
          try {
            if (action.type === "download") {
              // Phase 5 wires the download. The row is listed so the manager matches /llama.
            } else if (action.model.is_loading) {
              ctx.ui.notify(`${action.model.id} is loading`, "warning");
            } else if (action.model.loaded) {
              await unloadModel(ctx, ui, client, action.model);
            } else {
              await loadModel(ctx, ui, client, catalog.status, action.model);
            }
          } catch (error) {
            actionError = error;
          }
          const refreshed = await readCatalog();
          if (!refreshed) return;
          catalog = refreshed;
          if (actionError !== undefined && !isConnectionError(actionError)) {
            ctx.ui.notify(errorText(actionError), "error");
          }
        }
      });
    },
  });
}
