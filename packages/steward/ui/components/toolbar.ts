/**
 * The console toolbar: the active-model pill, the two chip groups, the search
 * box, the line count, and the pause/copy/download controls.
 *
 * It lays out as two explicit rows rather than one wrapping row, so chips from
 * different groups can never end up adjacent across a wrap and read as one
 * control set.
 */

import type { FamilyChipVm, LevelChipVm, ToolbarVm } from "../../core/select.js";
import type { FamilyFilter, LevelFilter } from "../../core/state.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, syncRows } from "../dom.js";

export interface ToolbarHandlers {
  onLevel: (level: LevelFilter) => void;
  onFamily: (family: FamilyFilter) => void;
  onQuery: (query: string) => void;
  onToggleProxy: () => void;
  onTogglePause: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

/** One chip in either group: a label, a count, and the value it selects. */
interface ChipRow<T> {
  root: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  value: T;
}

/** The vm both groups satisfy — the same component, a different axis. */
interface ChipVm {
  label: string;
  countLabel: string;
  ariaLabel: string;
  active: boolean;
  background: string;
  color: string;
  borderColor: string;
}

/**
 * A group of chips. The record-type chips and the level chips are the same
 * component with a different handler and vm, so there is one chip to style,
 * one to keep accessible, and no second thing to keep in step.
 */
function createChipGroup<T>(
  container: HTMLElement,
  initial: T,
  onPress: (value: T) => void,
): { rows: ChipRow<T>[]; update: (chips: readonly (ChipVm & { value: T })[]) => void } {
  const rows: ChipRow<T>[] = [];

  function create(): ChipRow<T> {
    const label = el("span", { class: "chip__label" });
    // The count is its own span so it can hold the muted colour whatever the
    // chip's state is: a zero must never read as a tick, least of all on ERROR.
    const count = el("span", { class: "chip__count" });
    const row: ChipRow<T> = {
      root: el("button", { class: "chip", attrs: { type: "button" }, children: [label, count] }),
      label,
      count,
      value: initial,
    };
    row.root.addEventListener("click", () => {
      onPress(row.value);
    });
    return row;
  }

  return {
    rows,
    update(chips) {
      syncRows(container, rows, chips.length, create);
      chips.forEach((chip, index) => {
        const row = rows[index];
        if (row === undefined) return;
        row.value = chip.value;
        setText(row.label, chip.label);
        setText(row.count, chip.countLabel);
        setVar(row.root, "bg", chip.background);
        setVar(row.root, "fg", chip.color);
        setVar(row.root, "bd", chip.borderColor);
        setAttr(row.root, "aria-pressed", String(chip.active));
        // The visible label is `WARN 2`, which a screen reader would read as
        // two unrelated tokens. The name says what the number is.
        setAttr(row.root, "aria-label", chip.ariaLabel);
      });
    },
  };
}

export function createToolbar(handlers: ToolbarHandlers): View<ToolbarVm> {
  const families = el("div", {
    class: "toolbar__chips",
    attrs: { role: "group", "aria-label": "Record type" },
  });
  const levels = el("div", {
    class: "toolbar__chips",
    attrs: { role: "group", "aria-label": "Log level" },
  });
  const familyGroup = createChipGroup<FamilyFilter>(families, "any", handlers.onFamily);
  const levelGroup = createChipGroup<LevelFilter>(levels, "all", handlers.onLevel);

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

  // Focus order: filter label → model pill → kind group → proxied toggle →
  // level group → search → count → pause → copy → download.
  const root = el("div", {
    class: "toolbar",
    children: [
      el("div", {
        class: "toolbar__row",
        children: [
          el("span", { class: "toolbar__label", text: "filter" }),
          active,
          el("span", { class: "toolbar__label", text: "kind" }),
          families,
          proxy,
        ],
      }),
      el("div", {
        class: "toolbar__row",
        children: [
          el("span", { class: "toolbar__label", text: "level" }),
          levels,
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
      }),
    ],
  });

  return {
    el: root,
    update(vm) {
      setText(active, vm.activeModelLabel);
      setVar(active, "bg", vm.activeModelBackground);
      setVar(active, "fg", vm.activeModelColor);

      familyGroup.update(
        vm.familyChips.map((chip: FamilyChipVm) => ({ ...chip, value: chip.family })),
      );
      levelGroup.update(vm.levelChips.map((chip: LevelChipVm) => ({ ...chip, value: chip.level })));

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
