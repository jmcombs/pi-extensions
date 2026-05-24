/**
 * Bordered Popup TUI Helpers
 *
 * These are reusable, self-contained helpers for creating polished,
 * consistent bordered popups inside Pi extensions using `ctx.ui.custom({ overlay: true })`.
 *
 * They were originally developed in the 1Password extension and are provided
 * here as a copy-paste starting point for any extension that needs rich
 * interactive flows (select lists with live filtering, text input, confirms)
 * that look and feel better than the basic `ctx.ui.select / input / confirm`.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   selectInBorderedPopup,
 *   confirmInBorderedPopup,
 *   inputInBorderedPopup,
 * } from "./ui/bordered-popups.js";
 *
 * const choice = await selectInBorderedPopup(ctx, {
 *   title: "Select something",
 *   items: [...],
 * });
 *
 * const confirmed = await confirmInBorderedPopup(ctx, {
 *   title: "Are you sure?",
 * });
 *
 * const name = await inputInBorderedPopup(ctx, {
 *   title: "Enter name",
 *   prompt: "What should we call it?",
 * });
 * ```
 *
 * The helpers automatically handle:
 * - Consistent 4-sided borders (╭─╮│╰╯) with stable right edge
 * - Proper ANSI-aware padding using Pi's `truncateToWidth`
 * - Live filtering on long lists
 * - Back navigation ("← Go back") and Esc-to-cancel semantics
 * - Theming consistent with the rest of Pi
 *
 * ## When to use
 *
 * Use these when you have:
 * - Long lists that benefit from filtering
 * - Multi-step wizards
 * - Situations where the basic Pi UI dialogs feel too plain
 *
 * For very simple one-off prompts, the built-in `ctx.ui.select/input/confirm`
 * are still perfectly acceptable and require less code.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Internal helper to render a consistent bordered box. */
export function renderBorderedBox(
  width: number,
  title: string,
  bodyLines: string[],
  footer: string | undefined,
  theme: any,
  truncateToWidthFn: (s: string, w: number, e?: string, pad?: boolean) => string,
): string[] {
  const innerWidth = Math.max(20, width - 4);
  const top = theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮");
  const bottom = theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯");

  const rawTitle = theme.fg("accent", theme.bold(title));
  const titlePadded = truncateToWidthFn(rawTitle, innerWidth, "", true);
  const borderedTitle = theme.fg("accent", "│ ") + titlePadded + theme.fg("accent", " │");

  const borderedBody = bodyLines.map((line) => {
    const padded = truncateToWidthFn(line || "", innerWidth, "", true);
    return theme.fg("accent", "│ ") + padded + theme.fg("accent", " │");
  });

  const lines = [top, borderedTitle, ...borderedBody];

  if (footer) {
    const rawFooter = theme.fg("dim", footer);
    const footerPadded = truncateToWidthFn(rawFooter, innerWidth, "", true);
    lines.push(theme.fg("accent", "│ ") + footerPadded + theme.fg("accent", " │"));
  }

  lines.push(bottom);
  return lines;
}

/**
 * High-level helper for a filterable list inside a bordered popup.
 * Returns the chosen `.value` or `null` (on cancel / Esc).
 */
export async function selectInBorderedPopup<T = string>(
  ctx: ExtensionCommandContext,
  opts: {
    title: string;
    items: Array<{ value: T; label: string; description?: string }>;
    helpText?: string;
    maxVisible?: number;
  },
): Promise<T | null> {
  const maxVis = opts.maxVisible ?? 14;
  const help = opts.helpText ?? "↑↓ • Enter • Esc = cancel • Type to filter";

  return (await (ctx.ui.custom as any)(
    async (tui: any, theme: any, _kb: any, done: (v?: any) => void) => {
      const { SelectList, Container, truncateToWidth } = await import(
        "@earendil-works/pi-tui"
      );

      let currentList: any = null;

      function build() {
        currentList = new SelectList(
          opts.items.map((it) => ({
            value: it.value,
            label: it.label,
            description: it.description,
          })),
          maxVis,
          {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          },
        );

        currentList.onSelect = (item: any) => done(item.value);
        currentList.onCancel = () => done(null);
      }

      build();

      const container = new Container();

      return {
        render(width: number) {
          const listLines = currentList
            ? currentList.render(Math.max(20, width - 4))
            : [];
          return renderBorderedBox(
            width,
            opts.title,
            listLines,
            help,
            theme,
            truncateToWidth,
          );
        },
        invalidate() {
          container.invalidate();
          currentList?.invalidate?.();
        },
        handleInput(d: string) {
          currentList?.handleInput(d);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  )) as T | null;
}

/** Yes/No (or custom labels) confirmation inside a bordered popup. */
export async function confirmInBorderedPopup(
  ctx: ExtensionCommandContext,
  opts: {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  },
): Promise<boolean> {
  const yes = opts.confirmLabel ?? "Yes";
  const no = opts.cancelLabel ?? "No";
  const items = [
    { value: true, label: yes },
    { value: false, label: no },
  ];

  const choice = await selectInBorderedPopup(ctx, {
    title: opts.title,
    items,
    helpText: "↑↓ • Enter to confirm • Esc = cancel",
    maxVisible: 5,
  });

  return choice === true;
}

/**
 * Bordered popup text input powered by Pi's Editor component.
 * Good for free-text entry while staying inside the custom popup aesthetic.
 */
export async function inputInBorderedPopup(
  ctx: ExtensionCommandContext,
  opts: {
    title: string;
    prompt?: string;
    defaultValue?: string;
    helpText?: string;
  },
): Promise<string | undefined> {
  const help = opts.helpText ?? "Enter to confirm • Esc = cancel";

  return (await (ctx.ui.custom as any)(
    async (tui: any, theme: any, _kb: any, done: (v?: any) => void) => {
      const { Editor, matchesKey, truncateToWidth } = await import(
        "@earendil-works/pi-tui"
      );

      const editorTheme = {
        borderColor: (s: string) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        },
      };

      const editor = new Editor(tui, editorTheme);
      if (opts.defaultValue) {
        editor.setText(opts.defaultValue);
      }

      editor.onSubmit = (value: string) => {
        done(value.trim() || undefined);
      };

      return {
        render(width: number) {
          const innerWidth = Math.max(20, width - 4);
          const body: string[] = [];

          if (opts.prompt) {
            body.push(theme.fg("text", opts.prompt));
            body.push("");
          }

          const editorLines = editor.render(innerWidth);
          body.push(...editorLines);

          return renderBorderedBox(
            width,
            opts.title,
            body,
            help,
            theme,
            truncateToWidth,
          );
        },
        invalidate() {
          editor.invalidate?.();
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape")) {
            done(undefined);
            return;
          }
          editor.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  )) as string | undefined;
}
