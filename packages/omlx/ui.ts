/**
 * `/omlx` manager views.
 *
 * Titles, item text, and key hints match Pi's llama.cpp manager, with
 * `llama.cpp` replaced by `omlx`. The download row says MLX only: this
 * extension does not offer GGUF quantizations. `DynamicBorder` and
 * `keyHint` are optional host APIs, so they are reached through a namespace
 * import and a runtime check.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import * as piRuntime from "@earendil-works/pi-coding-agent";
import type { Component, Keybinding } from "@earendil-works/pi-tui";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { contextWindowOf, displayIdOf, isChatRow, isDecisionRow, isGgufRow } from "./catalog.js";
import type { OmlxListedModel, OmlxModelStatus, OmlxStatusRow } from "./client.js";

const DOWNLOAD_VALUE = "\0download";

export const DOWNLOAD_ITEM_LABEL = "Download model…";
export const DOWNLOAD_ITEM_DESCRIPTION = "Hugging Face owner/repository (MLX only)";

export interface ManagerItem {
  value: string;
  label: string;
  description: string;
}

export interface OmlxProgress {
  message: string;
  ratio?: number;
  detail?: string;
}

export type OmlxManagerAction =
  | { type: "model"; model: OmlxStatusRow }
  | { type: "download" }
  | { type: "close" };

interface ProgressState extends OmlxProgress {
  title: string;
  model: string;
}

export interface OmlxUi {
  showModels(
    serverUrl: string,
    status: OmlxModelStatus,
    listed?: readonly OmlxListedModel[],
    cached?: ReadonlyMap<string, number>,
  ): Promise<OmlxManagerAction>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
  showStatus(title: string, message: string): void;
  progress(state: ProgressState): Promise<void>;
  updateProgress(state: ProgressState): void;
}

interface FocusTarget {
  focused?: boolean;
  handleInput?(data: string): void;
}

interface UiParts {
  DynamicBorder: typeof piRuntime.DynamicBorder;
  keyHint: typeof piRuntime.keyHint;
}

function uiParts(): UiParts | undefined {
  const { DynamicBorder, keyHint } = piRuntime;
  if (typeof DynamicBorder !== "function" || typeof keyHint !== "function") return undefined;
  return { DynamicBorder, keyHint };
}

function isManagerRow(row: OmlxStatusRow): boolean {
  return !isGgufRow(row) && (isChatRow(row) || isDecisionRow(row));
}

function compareManagerRows(left: OmlxStatusRow, right: OmlxStatusRow): number {
  const loaded = Number(right.loaded) - Number(left.loaded);
  return loaded || left.id.localeCompare(right.id);
}

/** Physical non-GGUF llm, vlm, and decision rows, loaded first, then by id. */
export function managerRows(rows: readonly OmlxStatusRow[]): OmlxStatusRow[] {
  return rows.filter(isManagerRow).sort(compareManagerRows);
}

function contextLabel(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function listedMaxModelLen(
  listed: readonly OmlxListedModel[],
  displayId: string,
): number | undefined {
  const value = listed.find((model) => model.id === displayId)?.max_model_len;
  return typeof value === "number" ? value : undefined;
}

/**
 * Loaded rows show `loaded` plus the row 23 context label. `is_loading` shows
 * `loading`. Unloaded rows show nothing.
 */
function rowDescription(
  row: OmlxStatusRow,
  listed: readonly OmlxListedModel[],
  cached: ReadonlyMap<string, number> | undefined,
): string {
  if (row.is_loading) return "loading";
  if (!row.loaded) return "";
  const displayId = displayIdOf(row);
  const window = contextWindowOf(row, listedMaxModelLen(listed, displayId), cached?.get(displayId));
  return `loaded · ${contextLabel(window)} context`;
}

/** Manager list, including the trailing download row. */
export function buildManagerItems(
  status: OmlxModelStatus,
  listed: readonly OmlxListedModel[] = [],
  cached?: ReadonlyMap<string, number>,
): ManagerItem[] {
  return [
    ...managerRows(status.models).map((row) => ({
      value: row.id,
      label: row.id,
      description: rowDescription(row, listed, cached),
    })),
    {
      value: DOWNLOAD_VALUE,
      label: DOWNLOAD_ITEM_LABEL,
      description: DOWNLOAD_ITEM_DESCRIPTION,
    },
  ];
}

function selectTheme(theme: Theme): {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
} {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

function frame(
  parts: UiParts,
  theme: Theme,
  title: string,
  body: Component[],
  footer?: string,
): Container {
  const container = new Container();
  container.addChild(new parts.DynamicBorder((text) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const child of body) container.addChild(child);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));
  }
  container.addChild(new parts.DynamicBorder((text) => theme.fg("accent", text)));
  return container;
}

function hint(parts: UiParts, keybinding: Keybinding, description: string): string {
  return parts.keyHint(keybinding, description);
}

class OmlxView implements Component {
  private content: Container;
  private inputHandler: FocusTarget | undefined;
  private inputTarget: FocusTarget | undefined;
  private progressPromise: Promise<void> | undefined;
  private progressResolver: (() => void) | undefined;
  private showingProgress = false;
  private focusedState = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly parts: UiParts,
  ) {
    this.content = frame(parts, theme, "omlx models", [
      new Text(theme.fg("muted", "Loading…"), 1, 1),
    ]);
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    if (this.inputTarget) this.inputTarget.focused = value;
  }

  private setContent(
    content: Container,
    inputHandler?: FocusTarget,
    inputTarget?: FocusTarget,
  ): void {
    if (this.inputTarget) this.inputTarget.focused = false;
    this.progressPromise = undefined;
    this.progressResolver = undefined;
    this.showingProgress = false;
    this.content = content;
    this.inputHandler = inputHandler;
    this.inputTarget = inputTarget ?? inputHandler;
    if (this.inputTarget) this.inputTarget.focused = this.focusedState;
    this.tui.requestRender();
  }

  showModels(
    serverUrl: string,
    status: OmlxModelStatus,
    listed: readonly OmlxListedModel[] = [],
    cached?: ReadonlyMap<string, number>,
  ): Promise<OmlxManagerAction> {
    const rows = managerRows(status.models);
    const byId = new Map(rows.map((model) => [model.id, model]));
    const items = buildManagerItems(status, listed, cached);
    return new Promise((resolve) => {
      const list = new SelectList(items, Math.min(items.length, 12), selectTheme(this.theme), {
        minPrimaryColumnWidth: 36,
        maxPrimaryColumnWidth: 56,
      });
      list.onSelect = (item) => {
        if (item.value === DOWNLOAD_VALUE) {
          resolve({ type: "download" });
          return;
        }
        const model = byId.get(item.value);
        if (model) resolve({ type: "model", model });
      };
      list.onCancel = () => {
        resolve({ type: "close" });
      };
      this.setContent(
        frame(
          this.parts,
          this.theme,
          "omlx models",
          [new Text(this.theme.fg("dim", serverUrl), 1, 0), new Spacer(1), list],
          `${hint(this.parts, "tui.select.confirm", "load/unload/download")} • ${hint(this.parts, "tui.select.cancel", "close")}`,
        ),
        list,
      );
    });
  }

  select(title: string, options: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const list = new SelectList(
        options.map((option) => ({ value: option, label: option })),
        Math.min(options.length, 12),
        selectTheme(this.theme),
      );
      list.onSelect = (item) => {
        resolve(item.value);
      };
      list.onCancel = () => {
        resolve(undefined);
      };
      this.setContent(
        frame(
          this.parts,
          this.theme,
          title,
          [new Spacer(1), list],
          `${hint(this.parts, "tui.select.confirm", "select")} • ${hint(this.parts, "tui.select.cancel", "cancel")}`,
        ),
        list,
      );
    });
  }

  async confirm(title: string, message: string): Promise<boolean> {
    return (await this.select(`${title}\n${message}`, ["Yes", "No"])) === "Yes";
  }

  async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
    const choice = await this.select(`omlx unavailable\n${serverUrl}\n\n${message}`, [
      "Retry",
      "Close",
    ]);
    return choice === "Retry" ? "retry" : "close";
  }

  showStatus(title: string, message: string): void {
    this.setContent(
      frame(this.parts, this.theme, title, [
        new Spacer(1),
        new Text(this.theme.fg("muted", message), 1, 0),
      ]),
    );
  }

  progress(state: ProgressState): Promise<void> {
    if (!this.progressPromise) {
      this.progressPromise = new Promise((resolve) => {
        this.progressResolver = resolve;
      });
    }
    this.showingProgress = true;
    this.updateProgress(state);
    return this.progressPromise;
  }

  updateProgress(state: ProgressState): void {
    if (!this.showingProgress) return;
    const body: Component[] = [
      new Text(this.theme.fg("text", state.model), 1, 0),
      new Spacer(1),
      new Text(this.theme.fg("muted", state.message), 1, 0),
    ];
    if (state.ratio !== undefined) {
      const available = 40;
      const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
      body.push(
        new Text(
          this.theme.fg(
            "accent",
            `${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
          ),
          1,
          0,
        ),
      );
    }
    if (state.detail) body.push(new Text(this.theme.fg("dim", state.detail), 1, 0));
    this.content = frame(
      this.parts,
      this.theme,
      state.title,
      body,
      hint(this.parts, "tui.select.cancel", "stop"),
    );
    this.inputHandler = undefined;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
      const resolve = this.progressResolver;
      this.progressPromise = undefined;
      this.progressResolver = undefined;
      resolve();
      return;
    }
    this.inputHandler?.handleInput?.(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.content
      .render(width)
      .map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

export async function showOmlxUi(
  ctx: ExtensionCommandContext,
  run: (ui: OmlxUi) => Promise<void>,
): Promise<void> {
  const parts = uiParts();
  if (!parts) {
    ctx.ui.notify("/omlx UI is unavailable on this host", "error");
    return;
  }
  await ctx.ui.custom((tui, theme, keybindings, done) => {
    const view = new OmlxView(tui, theme, keybindings, parts);
    void run(view).then(
      () => {
        done(undefined);
      },
      (error: unknown) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        done(undefined);
      },
    );
    return view;
  });
}

export async function runWithProgress<T>(
  ui: OmlxUi,
  options: {
    title: string;
    model: string;
    initialMessage: string;
    cancelTitle: string;
    cancelMessage: string;
    run(signal: AbortSignal, update: (progress: OmlxProgress) => void): Promise<T>;
    cancel(): Promise<void>;
  },
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
  const controller = new AbortController();
  const state: ProgressState = {
    title: options.title,
    model: options.model,
    message: options.initialMessage,
  };
  const settled = options
    .run(controller.signal, (progress) => {
      Object.assign(state, progress);
      ui.updateProgress(state);
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  let completed = false;
  settled.finally(() => {
    completed = true;
  });
  while (!completed) {
    const outcome = await Promise.race([
      settled.then(() => "settled" as const),
      ui.progress(state).then(() => "stop" as const),
    ]);
    if (outcome === "settled") break;
    const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
    if (!stop || completed) continue;
    try {
      await options.cancel();
    } finally {
      controller.abort(new Error("Cancelled"));
    }
    await settled;
    return { cancelled: true };
  }
  const result = await settled;
  if (!result.ok) throw result.error;
  return { cancelled: false, value: result.value };
}
