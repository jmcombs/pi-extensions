/**
 * The throughput-history cell: the last two minutes of tokens/second as bars,
 * with a dashed rule at the window's average.
 */

import type { SparkVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setStyle, setText, setVar, syncRows } from "../dom.js";

interface Bar {
  root: HTMLElement;
}

function createBar(): Bar {
  return { root: el("div", { class: "spark__bar" }) };
}

export function createSparkline(): View<SparkVm> {
  const bars: Bar[] = [];
  const summary = el("span", { class: "spark__summary" });
  const average = el("div", { class: "spark__avg" });
  const plot = el("div", { class: "spark__bars" });

  const root = el("div", {
    class: "metric",
    children: [
      el("div", {
        class: "spark__head",
        children: [el("span", { class: "eyebrow", text: "Throughput history" }), summary],
      }),
      el("div", { class: "spark__plot", children: [average, plot] }),
      el("div", {
        class: "spark__axis",
        children: [el("span", { text: "−2 min" }), el("span", { text: "now" })],
      }),
    ],
  });

  return {
    el: root,
    update(vm) {
      setText(summary, vm.summary);
      setStyle(average, "bottom", `${vm.averageLine}%`);
      syncRows(plot, bars, vm.bars.length, createBar);
      vm.bars.forEach((bar, index) => {
        const node = bars[index];
        if (node === undefined) return;
        setStyle(node.root, "height", `${bar.height}%`);
        setVar(node.root, "fill", bar.color);
      });
    },
  };
}
