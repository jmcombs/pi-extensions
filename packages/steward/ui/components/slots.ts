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
  rate: HTMLElement;
  peak: HTMLElement;
}

function createChip(): ChipView {
  const dot = el("span", { class: "slot-chip__dot", attrs: { "aria-hidden": "true" } });
  const name = el("span", { class: "slot-chip__name" });
  const count = el("span", { class: "slot-chip__count" });
  const rate = el("span", { class: "slot-chip__rate" });
  const peak = el("span", { class: "slot-chip__peak" });
  const root = el("div", { class: "slot-chip", children: [dot, name, count, rate, peak] });
  return { root, dot, name, count, rate, peak };
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
        const busy = group.busy > 0;
        setVar(chip.dot, "model-color", group.modelColor);
        setText(chip.name, group.modelLabel);
        setText(chip.count, group.summary);
        // A generating model shows how fast, right beside the fraction: the chip
        // reads `2/4 busy · 63 t/s`. Idle models, and ones whose child lacks
        // `--metrics`, have no rate, so the segment is dropped.
        setText(chip.rate, `· ${group.rateLabel}`);
        setAttr(chip.rate, "hidden", group.rateLabel === "");
        // The busiest lane's context fill rides beside the fraction on a busy
        // chip — the ambient overflow signal — colored by threshold but never
        // color-only, since the percentage is printed. Idle chips carry none.
        setText(chip.peak, `· ${group.peakLabel}`);
        setVar(chip.peak, "fg", group.peakColor);
        setAttr(chip.peak, "hidden", !busy);
        // A busy chip is called out so activity is legible without reading the
        // fraction; the color alone never carries it.
        setAttr(chip.root, "data-busy", busy ? "true" : "false");
        // The whole chip is one label so a screen reader reads "model, 1/4 busy"
        // (with the peak when busy) as a unit; the detail is on the title for a
        // pointer user.
        const ratePhrase = group.rateLabel === "" ? "" : `, ${group.rateLabel}`;
        setAttr(
          chip.root,
          "aria-label",
          busy
            ? `${group.modelLabel}, ${group.summary}${ratePhrase}, peak ${group.peakLabel} context`
            : `${group.modelLabel}, ${group.summary}`,
        );
        setAttr(chip.root, "title", chipTitle(group));
      });
    },
  };
}
