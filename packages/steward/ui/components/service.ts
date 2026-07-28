/**
 * The rail's SERVICE block — the "Steward" box.
 *
 * Three stacked zones: the brand lockup, a monitor-only status indicator (the
 * service is `started` / `stopped`; real start/stop/restart controls will take
 * this reserved row later), and the router facts folded in from what used to be
 * a separate CONFIG block. The status indicator is deliberately not a button:
 * it reports state and nothing more, so it is a `role="status"` region that a
 * screen reader announces when the state changes.
 */

import type { ServiceVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, svg, syncRows } from "../dom.js";

export interface ServiceHandlers {
  onToggleTheme: () => void;
}

/** One router fact: `listen   127.0.0.1:8080`. Patched per repaint. */
interface FactRow {
  root: HTMLElement;
  key: HTMLElement;
  value: HTMLElement;
}

function createFactRow(): FactRow {
  const key = el("span", { class: "config-row__key" });
  const value = el("span", { class: "config-row__value" });
  return { root: el("div", { class: "config-row", children: [key, value] }), key, value };
}

/** The Steward mark: a serving dome over two trays, the lower one faded. */
function mark(): SVGElement {
  return svg(
    "svg",
    {
      width: "20",
      height: "20",
      viewBox: "0 0 40 40",
      fill: "none",
      "aria-hidden": "true",
      class: "lockup__mark",
      focusable: "false",
    },
    [
      svg("path", {
        d: "M8 17C8 10.9 13.4 6 20 6s12 4.9 12 11",
        stroke: "currentColor",
        "stroke-width": "4",
        "stroke-linecap": "round",
      }),
      svg("rect", { x: "4", y: "21", width: "32", height: "5", rx: "2.5", fill: "currentColor" }),
      svg("rect", {
        x: "4",
        y: "29.6",
        width: "32",
        height: "5",
        rx: "2.5",
        fill: "currentColor",
        opacity: "0.55",
      }),
    ],
  );
}

export function createServiceBlock(handlers: ServiceHandlers): View<ServiceVm> {
  const statusDot = el("span", { class: "service__status-dot", attrs: { "aria-hidden": "true" } });
  const statusLabel = el("span", { class: "service__status-label" });
  // Not a <button>: monitor-only. The reserved control real estate reads as a
  // filled control, but it never takes hover, focus or a click.
  const status = el("div", {
    class: "service__status",
    attrs: { role: "status", "aria-live": "polite" },
    children: [statusDot, statusLabel],
  });
  const theme = el("button", {
    class: "btn btn--icon",
    attrs: { type: "button" },
    on: { click: handlers.onToggleTheme },
  });
  const facts = el("div", { class: "config-list service__facts" });
  const rows: FactRow[] = [];

  const root = el("section", {
    class: "rail__block rail__block--service",
    // The block has no eyebrow to point at, and the lockup is the page's h1
    // rather than this region's heading.
    attrs: { "aria-label": "Service" },
    children: [
      el("div", {
        class: "lockup",
        children: [mark(), el("h1", { class: "lockup__name", text: "Steward" })],
      }),
      el("div", { class: "service__status-row", children: [status, theme] }),
      facts,
    ],
  });

  return {
    el: root,
    update(vm) {
      setAttr(status, "data-state", vm.running ? "up" : "down");
      setVar(status, "bg", vm.statusTint);
      setVar(status, "bd", vm.statusBorder);
      setVar(status, "fg", vm.statusColor);
      setVar(statusDot, "fill", vm.statusColor);
      setText(statusLabel, vm.statusLabel);
      setAttr(status, "aria-label", `Service ${vm.statusLabel}`);

      setText(theme, vm.themeGlyph);
      setAttr(theme, "aria-label", vm.themeLabel);
      setAttr(theme, "title", vm.themeLabel);

      syncRows(facts, rows, vm.config.length, createFactRow);
      vm.config.forEach((entry, index) => {
        const row = rows[index];
        if (row === undefined) return;
        // `label: value`, the same grammar the model-card fields use.
        setText(row.key, `${entry.key}:`);
        setText(row.value, entry.value);
      });
    },
  };
}
