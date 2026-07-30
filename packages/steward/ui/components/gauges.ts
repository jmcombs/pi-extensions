/**
 * The rail's HOST block: labelled bars for the box's own vitals, plus the one
 * control that changes how they are labelled.
 *
 * The temperature-unit button lives here and nowhere else. Proximity is the
 * whole of its discoverability — a unit token beside the numbers it labels
 * needs no explanation, and the same button in the SERVICE box would be a
 * mystery glyph next to the theme toggle. It is also the only block that knows
 * whether it has anything to relabel.
 */

import type { GaugeVm, TemperatureControlVm } from "../../core/select.js";
import type { TemperaturePreference } from "../../core/temperature.js";
import type { View } from "../dom.js";
import { el, setAttr, setStyle, setText, setVar, syncRows } from "../dom.js";

export interface HostHandlers {
  /** Cycles the stored preference: auto → °C → °F → auto. */
  onCycleTemperature: (next: TemperaturePreference) => void;
}

/** What this block renders: the gauge rows, and the control that labels them. */
export interface HostVm {
  gauges: GaugeVm[];
  /** `null` when no gauge is a temperature row — the control is then absent. */
  temperature: TemperatureControlVm | null;
}

interface GaugeRow {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
}

function createRow(): GaugeRow {
  const label = el("span", { class: "gauge__label" });
  const value = el("span", { class: "gauge__value" });
  const fill = el("div", { class: "bar__fill" });
  const bar = el("div", { class: "bar", children: [fill] });
  const root = el("div", {
    class: "gauge",
    children: [el("div", { class: "gauge__head", children: [label, value] }), bar],
  });
  return { root, label, value, bar, fill };
}

export function createHostBlock(handlers: HostHandlers): View<HostVm> {
  const rows: GaugeRow[] = [];
  const list = el("div", { class: "gauges" });

  // The preference this button will move to on its next press. It lives on the
  // closure rather than in the listener so the row can be patched across
  // repaints without rebinding, exactly as the service controls are.
  let nextPreference: TemperaturePreference = "celsius";
  const unit = el("button", {
    class: "btn btn--sm host__unit",
    attrs: { type: "button", hidden: true },
    on: {
      click: () => {
        handlers.onCycleTemperature(nextPreference);
      },
    },
  });

  const root = el("section", {
    class: "rail__block rail__block--host",
    // `tabindex="-1"` makes the block itself a focus anchor. It is never in the
    // tab order; it exists so that when the unit control unmounts under a
    // keyboard operator's focus, there is somewhere in this block to land.
    attrs: { "aria-labelledby": "steward-host-title", tabindex: "-1" },
    children: [
      el("div", {
        class: "block__head",
        children: [
          el("h2", { class: "eyebrow", text: "Host", attrs: { id: "steward-host-title" } }),
          unit,
        ],
      }),
      list,
    ],
  });

  return {
    el: root,
    update(vm) {
      // The row count only moves when the host stops reporting a sensor, so
      // this is a resize on a handful of elements, not a rebuild.
      syncRows(list, rows, vm.gauges.length, createRow);
      vm.gauges.forEach((gauge, index) => {
        const row = rows[index];
        if (row === undefined) return;
        setText(row.label, gauge.label);
        setText(row.value, gauge.value);
        setVar(row.value, "fill", gauge.color);
        setVar(row.fill, "fill", gauge.color);
        setStyle(row.fill, "width", `${gauge.percent}%`);
        // The track texture reinforces the value token: a hatched bar reads as
        // "no reading" and can't be mistaken for a real, solid 0% fill.
        setAttr(row.bar, "data-track", gauge.track);
      });

      // Read BEFORE the control is hidden. A machine whose last temperature
      // sensor stops reporting drops its temperature rows, which takes this
      // button with them — and hiding the focused element drops focus to the
      // document. Landing on the block keeps the operator where they were.
      const focusWasOnUnit = unit.contains(document.activeElement);
      setAttr(unit, "hidden", vm.temperature === null);
      if (vm.temperature === null) {
        if (focusWasOnUnit) root.focus();
        return;
      }
      nextPreference = vm.temperature.next;
      setText(unit, vm.temperature.label);
      setAttr(unit, "aria-label", vm.temperature.ariaLabel);
      setAttr(unit, "title", vm.temperature.title);
    },
  };
}
