/**
 * The SLOTS panel: how many concurrent requests each loaded model is running.
 *
 * A "slot" is one request lane inside a single model's `llama-server` — a model
 * loaded with `--parallel 4` has four of them, and its context is split across
 * them. It is not a seat for a model (that ceiling is the router's `max models`,
 * shown in CONFIG). So the panel reads as one compact chip per loaded model:
 * a colored dot, the model's short name, and how many of its slots are busy.
 * The per-slot context detail — how full each lane's context is — rides on the
 * chip's hover title rather than taking a row of its own. With nothing loaded
 * the panel collapses to a single empty note.
 */

import type { SlotGroupVm, SlotsVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, syncRows } from "../dom.js";

interface ChipView {
  root: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
}

function createChip(): ChipView {
  const dot = el("span", { class: "slot-chip__dot", attrs: { "aria-hidden": "true" } });
  const name = el("span", { class: "slot-chip__name" });
  const count = el("span", { class: "slot-chip__count" });
  const root = el("div", { class: "slot-chip", children: [dot, name, count] });
  return { root, dot, name, count };
}

/** The hover text: each of the model's slots and how full its context is. */
function chipTitle(group: SlotGroupVm): string {
  const lanes = group.slots.map((slot) => `slot ${slot.id}: ${slot.detail}`).join("\n");
  return `${group.modelLabel} — ${group.summary}\n${lanes}`;
}

export function createSlotsStrip(): View<SlotsVm> {
  const chips: ChipView[] = [];
  const summary = el("span", { class: "slots__summary" });
  const row = el("div", { class: "slots__chips" });
  const empty = el("span", { class: "slots__empty", attrs: { hidden: true } });

  const root = el("section", {
    class: "slots",
    attrs: { "aria-labelledby": "steward-slots-title" },
    children: [
      el("div", {
        class: "slots__head",
        children: [
          el("h2", { class: "eyebrow", text: "Slots", attrs: { id: "steward-slots-title" } }),
          summary,
        ],
      }),
      empty,
      row,
    ],
  });

  return {
    el: root,
    update(vm) {
      setText(summary, vm.totalSummary);
      setText(empty, vm.emptyLabel);
      // The note stands in for the chip row only when nothing is loaded.
      setAttr(empty, "hidden", !vm.empty);

      syncRows(row, chips, vm.empty ? 0 : vm.groups.length, createChip);
      vm.groups.forEach((group, index) => {
        const chip = chips[index];
        if (chip === undefined) return;
        setVar(chip.dot, "model-color", group.modelColor);
        setText(chip.name, group.modelLabel);
        setText(chip.count, group.summary);
        // A busy chip is called out so activity is legible without reading the
        // fraction; the color alone never carries it.
        setAttr(chip.root, "data-busy", group.busy > 0 ? "true" : "false");
        // The whole chip is one label so a screen reader reads "model, 1/4 busy"
        // as a unit; the detail is on the title for a pointer user.
        setAttr(chip.root, "aria-label", `${group.modelLabel}, ${group.summary}`);
        setAttr(chip.root, "title", chipTitle(group));
      });
    },
  };
}
