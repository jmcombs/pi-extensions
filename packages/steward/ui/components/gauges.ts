/** The rail's HOST block: labelled bars for the box's own vitals. */

import type { GaugeVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setStyle, setText, setVar, syncRows } from "../dom.js";

interface GaugeRow {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
}

function createRow(): GaugeRow {
  const label = el("span", { class: "gauge__label" });
  const value = el("span", { class: "gauge__value" });
  const fill = el("div", { class: "bar__fill" });
  const root = el("div", {
    class: "gauge",
    children: [
      el("div", { class: "gauge__head", children: [label, value] }),
      el("div", { class: "bar", children: [fill] }),
    ],
  });
  return { root, label, value, fill };
}

export function createHostBlock(): View<GaugeVm[]> {
  const rows: GaugeRow[] = [];
  const list = el("div", { class: "gauges" });
  const root = el("section", {
    class: "rail__block rail__block--host",
    attrs: { "aria-labelledby": "steward-host-title" },
    children: [
      el("h2", { class: "eyebrow", text: "Host", attrs: { id: "steward-host-title" } }),
      list,
    ],
  });

  return {
    el: root,
    update(gauges) {
      // The row count only moves when the host stops reporting a sensor, so
      // this is a resize on a handful of elements, not a rebuild.
      syncRows(list, rows, gauges.length, createRow);
      gauges.forEach((gauge, index) => {
        const row = rows[index];
        if (row === undefined) return;
        setText(row.label, gauge.label);
        setText(row.value, gauge.value);
        setVar(row.value, "fill", gauge.color);
        setVar(row.fill, "fill", gauge.color);
        setStyle(row.fill, "width", `${gauge.percent}%`);
      });
    },
  };
}
