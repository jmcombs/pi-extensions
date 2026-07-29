/**
 * The console toolbar: the active-model pill, the level chips, the search box,
 * the line count, and the pause/copy/download controls.
 */

import type { LevelChipVm, ToolbarVm } from "../../core/select.js";
import type { LevelFilter } from "../../core/state.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, syncRows } from "../dom.js";

export interface ToolbarHandlers {
  onLevel: (level: LevelFilter) => void;
  onQuery: (query: string) => void;
  onToggleProxy: () => void;
  onTogglePause: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

interface ChipRow {
  root: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  level: LevelFilter;
}

export function createToolbar(handlers: ToolbarHandlers): View<ToolbarVm> {
  const chips: ChipRow[] = [];
  const levels = el("div", {
    class: "toolbar__levels",
    attrs: { role: "group", "aria-label": "Log level" },
  });

  const active = el("span", { class: "toolbar__active" });
  const search = el("input", {
    class: "search",
    // A plain text input: `type="search"` would add a UA cancel button and, on
    // WebKit, a searchfield appearance that overrides the box below.
    attrs: { type: "text", id: "steward-search", placeholder: "search log…" },
    on: {
      input: (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLInputElement) handlers.onQuery(target.value);
      },
    },
  });
  // The two filtering controls sit together: level group, then this, then the
  // search box. Focus order is label → model pill → levels → proxied → search →
  // count → pause → copy → download.
  const proxy = el("button", {
    class: "chip chip--proxy",
    attrs: { type: "button" },
    on: { click: handlers.onToggleProxy },
  });
  const count = el("span", { class: "toolbar__count" });
  const pause = el("button", {
    class: "chip chip--pause",
    attrs: { type: "button" },
    on: { click: handlers.onTogglePause },
  });
  const copy = el("button", {
    class: "btn btn--toolbar",
    attrs: { type: "button" },
    text: "Copy",
    on: { click: handlers.onCopy },
  });
  const download = el("button", {
    class: "btn btn--toolbar",
    attrs: { type: "button" },
    text: "Download",
    on: { click: handlers.onDownload },
  });

  const root = el("div", {
    class: "toolbar",
    children: [
      el("span", { class: "toolbar__label", text: "filter" }),
      active,
      levels,
      proxy,
      el("label", {
        class: "visually-hidden",
        text: "Search the log",
        attrs: { for: "steward-search" },
      }),
      search,
      count,
      pause,
      copy,
      download,
    ],
  });

  function createChip(): ChipRow {
    const label = el("span", { class: "chip__label" });
    // The count is its own span so it can hold the muted colour whatever the
    // chip's state is: a zero must never read as a tick, least of all on ERROR.
    const count = el("span", { class: "chip__count" });
    const row: ChipRow = {
      root: el("button", { class: "chip", attrs: { type: "button" }, children: [label, count] }),
      label,
      count,
      level: "all",
    };
    row.root.addEventListener("click", () => {
      handlers.onLevel(row.level);
    });
    return row;
  }

  function paintChip(row: ChipRow, chip: LevelChipVm): void {
    row.level = chip.level;
    setText(row.label, chip.label);
    setText(row.count, chip.countLabel);
    setVar(row.root, "bg", chip.background);
    setVar(row.root, "fg", chip.color);
    setVar(row.root, "bd", chip.borderColor);
    setAttr(row.root, "aria-pressed", String(chip.active));
    // The visible label is `WARN 2`, which a screen reader would read as two
    // unrelated tokens. The name says what the number is.
    setAttr(row.root, "aria-label", chip.ariaLabel);
  }

  return {
    el: root,
    update(vm) {
      setText(active, vm.activeModelLabel);
      setVar(active, "bg", vm.activeModelBackground);
      setVar(active, "fg", vm.activeModelColor);

      syncRows(levels, chips, vm.levelChips.length, createChip);
      vm.levelChips.forEach((chip, index) => {
        const row = chips[index];
        if (row !== undefined) paintChip(row, chip);
      });

      setText(proxy, vm.proxyToggle.label);
      setAttr(proxy, "aria-pressed", String(vm.proxyToggle.pressed));
      setAttr(proxy, "aria-label", vm.proxyToggle.ariaLabel);
      setAttr(proxy, "title", vm.proxyToggle.title);

      // The operator owns the field while typing; only correct it if the state
      // and the box have genuinely drifted apart.
      if (search.value !== vm.query) search.value = vm.query;

      setText(count, vm.lineCountLabel);

      setText(pause, vm.pauseLabel);
      setVar(pause, "bg", vm.pauseBackground);
      setVar(pause, "fg", vm.pauseColor);
      setVar(pause, "bd", vm.pauseBorder);
      setAttr(pause, "aria-pressed", String(vm.paused));

      setText(copy, vm.copyLabel);
    },
  };
}
