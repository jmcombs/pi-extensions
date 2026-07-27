/**
 * The rail's service block: lockup, engine line, the start/stop, restart and
 * theme controls, and the state/uptime footer.
 */

import type { ServiceVm } from "../../core/select.js";
import type { ServiceAction } from "../../core/types.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, svg } from "../dom.js";

export interface ServiceHandlers {
  onService: (action: ServiceAction) => void;
  onToggleTheme: () => void;
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
  let action: ServiceAction = "stop";

  const dot = el("span", { class: "lockup__dot" });
  const engine = el("div", { class: "engine-line" });
  const control = el("button", {
    class: "btn btn--filled btn--block",
    attrs: { type: "button" },
    on: {
      click: () => {
        handlers.onService(action);
      },
    },
  });
  const restart = el("button", {
    class: "btn btn--md",
    attrs: { type: "button" },
    on: {
      click: () => {
        handlers.onService("restart");
      },
    },
  });
  const theme = el("button", {
    class: "btn btn--icon",
    attrs: { type: "button" },
    on: { click: handlers.onToggleTheme },
  });
  const state = el("span");
  const uptime = el("span");

  const root = el("section", {
    class: "rail__block rail__block--service",
    // The block has no eyebrow to point at, and the lockup is the page's h1
    // rather than this region's heading.
    attrs: { "aria-label": "Service" },
    children: [
      el("div", {
        class: "lockup",
        children: [mark(), el("h1", { class: "lockup__name", text: "Steward" }), dot],
      }),
      engine,
      el("div", { class: "service__controls", children: [control, restart, theme] }),
      el("div", { class: "service__footer", children: [state, uptime] }),
    ],
  });

  return {
    el: root,
    update(vm) {
      action = vm.controlAction;
      setVar(dot, "fill", vm.dotColor);
      setText(engine, vm.engineLine);

      setText(control, vm.controlLabel);
      setVar(control, "bg", vm.controlBackground);
      setVar(control, "fg", vm.controlColor);
      setAttr(control, "disabled", vm.pending);
      // The button changes what it does, not just how it reads, so the label
      // alone is not enough for a screen reader that has already announced it.
      setAttr(control, "aria-label", `${vm.controlLabel} (llama-server)`);

      setText(restart, vm.restartLabel);
      setAttr(restart, "disabled", vm.pending);

      setText(theme, vm.themeGlyph);
      setAttr(theme, "aria-label", vm.themeLabel);
      setAttr(theme, "title", vm.themeLabel);

      setText(state, vm.stateLabel);
      setText(uptime, vm.uptimeLabel);
    },
  };
}
