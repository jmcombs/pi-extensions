/**
 * The metrics band across the top of the main column: three KPI tiles plus the
 * throughput-history cell, which is passed in so this module owns only the
 * band's grid.
 */

import type { KpiVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setStyle, setText, setVar, syncRows } from "../dom.js";

interface KpiTile {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
  unit: HTMLElement;
  fill: HTMLElement;
  sub: HTMLElement;
}

function createTile(): KpiTile {
  const label = el("div", { class: "eyebrow" });
  const value = el("span", { class: "kpi__value" });
  const unit = el("span", { class: "kpi__unit" });
  const fill = el("div", { class: "bar__fill" });
  const sub = el("span", { class: "kpi__sub" });
  const root = el("div", {
    class: "metric",
    children: [
      label,
      el("div", { class: "kpi__row", children: [value, unit] }),
      el("div", { class: "bar bar--kpi", children: [fill] }),
      sub,
    ],
  });
  return { root, label, value, unit, fill, sub };
}

export function createMetricsBand(sparkline: HTMLElement): View<KpiVm[]> {
  const tiles: KpiTile[] = [];
  const root = el("section", { class: "metrics", attrs: { "aria-label": "Service metrics" } });

  return {
    el: root,
    update(kpis) {
      syncRows(root, tiles, kpis.length, createTile);
      // The chart is the band's last cell; re-appending keeps it there after a
      // tile is added or dropped, and is a no-op otherwise.
      if (root.lastElementChild !== sparkline) root.appendChild(sparkline);

      kpis.forEach((kpi, index) => {
        const tile = tiles[index];
        if (tile === undefined) return;
        setText(tile.label, kpi.label);
        setText(tile.value, kpi.value);
        setVar(tile.value, "fill", kpi.color);
        setText(tile.unit, kpi.unit);
        setVar(tile.fill, "fill", kpi.color);
        setStyle(tile.fill, "width", `${kpi.percent}%`);
        setText(tile.sub, kpi.sub);
      });
    },
  };
}
