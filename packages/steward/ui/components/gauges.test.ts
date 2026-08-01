/**
 * The HOST block's temperature-unit control.
 *
 * The control's whole justification is that it is adjacent to the rows it
 * relabels — which means it has to disappear when those rows do. That makes it
 * the fourth instance in this project of a control that unmounts under a
 * keyboard operator's focus, so the restore is pinned here rather than left to
 * a reviewer to notice.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GaugeVm, TemperatureControlVm } from "../../core/select.js";
import type { TemperaturePreference } from "../../core/temperature.js";
import type { StubDom } from "../__fixtures__/dom.js";
import { byClass, descendants, installStubDom } from "../__fixtures__/dom.js";
import { createHostBlock } from "./gauges.js";

let dom: StubDom;

beforeEach(() => {
  dom = installStubDom();
});

afterEach(() => {
  dom.restore();
});

function gauge(key: string, temperature: boolean): GaugeVm {
  return {
    key,
    label: key,
    value: temperature ? "64°C" : "78%",
    percent: 52,
    color: "var(--success)",
    track: "solid",
    temperature,
  };
}

function control(overrides: Partial<TemperatureControlVm> = {}): TemperatureControlVm {
  return {
    label: "auto",
    ariaLabel: "Temperature unit: automatic — °C from your browser region. Switch to always °C.",
    title: "Temperature unit: automatic — °C from your browser region. Switch to always °C.",
    next: "celsius",
    ...overrides,
  };
}

function host(onCycleTemperature: (next: TemperaturePreference) => void = () => undefined) {
  const view = createHostBlock({ onCycleTemperature });
  // The block is only ever appended to the rail; the stub's body stands in for
  // it so `contains` and focus behave the way they do on a live page.
  dom.body.appendChild(view.el);
  return view;
}

/** The unit button, found by its class the way the stylesheet finds it. */
function unitButton(root: Element): Element {
  return byClass(root, "host__unit");
}

describe("the HOST block's temperature-unit control", () => {
  it("renders only when a temperature gauge exists", () => {
    const view = host();

    view.update({ gauges: [gauge("gpu", false), gauge("cpu", false)], temperature: null });
    // Absent, not disabled: with no temperature row on screen the control would
    // provably change nothing, and a dead control reads as broken.
    expect(unitButton(view.el).getAttribute("hidden")).toBe("");

    view.update({ gauges: [gauge("gpu", false), gauge("gpu-temp", true)], temperature: control() });
    expect(unitButton(view.el).getAttribute("hidden")).toBeNull();
  });

  it("is a real button, labelled with the mode and the sentence that explains it", () => {
    const view = host();
    view.update({ gauges: [gauge("gpu-temp", true)], temperature: control() });
    const button = unitButton(view.el);

    expect(button.tagName.toLowerCase()).toBe("button");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe("auto");
    expect(button.getAttribute("aria-label")).toContain("Switch to always °C");
    expect(button.getAttribute("title")).toBe(button.getAttribute("aria-label"));
    // It is a control, not a status: a live region here would announce on every
    // repaint for a value that cannot change without a press.
    expect(button.getAttribute("aria-live")).toBeNull();
    expect(button.getAttribute("role")).toBeNull();
  });

  it("hands the handler the preference the cycle moves to, and relabels on the way back", () => {
    const pressed: TemperaturePreference[] = [];
    const view = host((next) => pressed.push(next));

    view.update({ gauges: [gauge("gpu-temp", true)], temperature: control() });
    dom.click(unitButton(view.el));
    // auto → °C
    view.update({
      gauges: [gauge("gpu-temp", true)],
      temperature: control({ label: "°C", next: "fahrenheit" }),
    });
    dom.click(unitButton(view.el));
    // °C → °F
    view.update({
      gauges: [gauge("gpu-temp", true)],
      temperature: control({ label: "°F", next: "auto" }),
    });
    dom.click(unitButton(view.el));

    expect(pressed).toEqual(["celsius", "fahrenheit", "auto"]);
    expect(unitButton(view.el).textContent).toBe("°F");
  });

  it("catches focus when the last temperature sensor stops reporting", () => {
    const view = host();
    view.update({ gauges: [gauge("gpu-temp", true)], temperature: control() });

    const button = unitButton(view.el) as unknown as HTMLElement;
    button.focus();
    expect(dom.activeElement()).toBe(button);

    // The sensor drops out: the row goes, and the control goes with it.
    view.update({ gauges: [gauge("gpu", false)], temperature: null });

    // Focus lands on the block, not on the document — which is where a hidden
    // element leaves it, and the bug this project has shipped three times.
    expect(dom.activeElement()).toBe(view.el);
    expect(dom.activeElement()).not.toBe(dom.body);
    // The anchor only works because the block itself is focusable in code.
    expect(view.el.getAttribute("tabindex")).toBe("-1");
  });

  it("leaves focus alone when the control unmounts with focus elsewhere", () => {
    const view = host();
    view.update({ gauges: [gauge("gpu-temp", true)], temperature: control() });
    const elsewhere = dom.body;
    expect(dom.activeElement()).toBe(elsewhere);

    view.update({ gauges: [gauge("gpu", false)], temperature: null });
    // Yanking focus from wherever the operator actually is would be its own bug.
    expect(dom.activeElement()).toBe(elsewhere);
  });

  it("keeps the eyebrow as the block's heading, with the control beside it", () => {
    const view = host();
    view.update({ gauges: [gauge("gpu-temp", true)], temperature: control() });
    const eyebrow = byClass(view.el, "eyebrow");
    expect(eyebrow.textContent).toBe("Host");
    expect(eyebrow.getAttribute("id")).toBe("steward-host-title");
    expect(view.el.getAttribute("aria-labelledby")).toBe("steward-host-title");
    // Head layout: eyebrow left, control right, in one `.block__head` — the
    // same shape the MODELS block already uses.
    const head = byClass(view.el, "block__head");
    expect(descendants(head).map((n) => n.className)).toEqual([
      "block__head",
      "eyebrow",
      "btn btn--sm host__unit",
    ]);
  });

  it("still patches the gauge rows it always did", () => {
    const view = host();
    view.update({
      gauges: [gauge("gpu", false), gauge("gpu-temp", true)],
      temperature: control(),
    });
    const rows = descendants(byClass(view.el, "gauges")).filter((n) => n.className === "gauge");
    expect(rows).toHaveLength(2);
    expect(byClass(rows[1] as Element, "gauge__value").textContent).toBe("64°C");
    expect(byClass(rows[1] as Element, "bar").getAttribute("data-track")).toBe("solid");
  });
});
