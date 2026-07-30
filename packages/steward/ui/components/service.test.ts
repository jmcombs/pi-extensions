/**
 * The SERVICE block's status chip, run against the real component.
 *
 * Two things here have shipped broken before and are pinned deliberately: the
 * chip is a `role="status"` readout and NOT a button, and it keeps
 * `tabindex="-1"` because two flows in `service.ts` park focus on it when the
 * control they came from goes away.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceVm } from "../../core/select.js";
import { SERVICE_STATE_PRESENTATION } from "../../core/select.js";
import type { StubDom } from "../__fixtures__/dom.js";
import { byAttribute, cssVar, descendants, installStubDom } from "../__fixtures__/dom.js";
import type { ServiceHandlers } from "./service.js";
import { createServiceBlock } from "./service.js";

let dom: StubDom;

beforeEach(() => {
  dom = installStubDom();
});

afterEach(() => {
  dom.restore();
});

function serviceVm(overrides: Partial<ServiceVm> = {}): ServiceVm {
  return {
    state: "up",
    statusLabel: SERVICE_STATE_PRESENTATION.up.label,
    statusDotColor: SERVICE_STATE_PRESENTATION.up.dotColor,
    themeGlyph: "◐",
    themeLabel: "Theme: System (matches your OS). Switch to light.",
    controls: { buttons: [], setup: null, confirm: null, notice: null, pending: false },
    drift: null,
    config: [],
    ...overrides,
  };
}

const INERT_HANDLERS: ServiceHandlers = {
  onToggleTheme: () => undefined,
  onService: () => undefined,
  onConfirmService: () => undefined,
  onCancelService: () => undefined,
  onDismissDrift: () => undefined,
};

/** A rendered block, plus the chip found the way a screen reader finds it. */
function block(vm: ServiceVm = serviceVm()) {
  const view = createServiceBlock(INERT_HANDLERS);
  view.update(vm);
  return { view, status: byAttribute(view.el, "role", "status") };
}

describe("the service status chip", () => {
  it("reports rather than acts, and stays reachable for programmatic focus", () => {
    const { status } = block();
    // Not a button: it has no action to offer, and dressing a readout as a
    // control is a promise the block cannot keep.
    expect(status.tagName.toLowerCase()).not.toBe("button");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // Never in the tab order, always focusable in code. Two flows in
    // service.ts land focus here when their opener has gone inert.
    expect(status.getAttribute("tabindex")).toBe("-1");
  });

  it("rides the lockup row, and the 36px status row is gone", () => {
    const { view, status } = block();
    expect((status.parentNode as unknown as Element).className).toBe("lockup");
    const classes = descendants(view.el).map((node) => node.className);
    expect(classes).not.toContain("service__status-row");
    // The theme control came with it, so the lockup carries both.
    const lockup = descendants(view.el).filter((node) => node.className === "lockup")[0];
    expect(lockup).toBeDefined();
    expect(descendants(lockup as Element).some((n) => n.tagName.toLowerCase() === "button")).toBe(
      true,
    );
  });

  it("carries the whole sentence as its accessible name, not the bare word", () => {
    const { view, status } = block();
    expect(status.getAttribute("aria-label")).toBe("Service started");
    view.update(serviceVm({ state: "down", statusLabel: "stopped" }));
    expect(status.getAttribute("aria-label")).toBe("Service stopped");
  });

  it("gives each state a distinct FORM and a distinct word, not just a hue", () => {
    const { view, status } = block();
    const dot = descendants(status).find((n) => n.className === "service__status-dot");
    expect(dot).toBeDefined();

    const seen = (["up", "down", "unknown"] as const).map((state) => {
      const presentation = SERVICE_STATE_PRESENTATION[state];
      view.update(
        serviceVm({
          state,
          statusLabel: presentation.label,
          statusDotColor: presentation.dotColor,
        }),
      );
      return {
        // The attribute the stylesheet keys three SHAPES off — filled disc,
        // ring, dotted ring. Asserting this rather than the colour is the whole
        // point: a reader who cannot see hue still gets three different forms.
        form: status.getAttribute("data-state"),
        word: status.textContent,
        hue: cssVar(dot as Element, "fill"),
      };
    });

    expect(seen.map((s) => s.form)).toEqual(["up", "down", "unknown"]);
    expect(seen.map((s) => s.word)).toEqual(["started", "stopped", "not connected"]);
    // Each signal separates all three states on its own, so no state depends on
    // any other signal being perceivable.
    expect(new Set(seen.map((s) => s.form)).size).toBe(3);
    expect(new Set(seen.map((s) => s.word)).size).toBe(3);
    expect(new Set(seen.map((s) => s.hue)).size).toBe(3);
  });

  it("keeps the state's hue on the dot and off the chip's own text", () => {
    // The word's colour belongs to the stylesheet, fixed to a token that clears
    // AA in both themes. If the component started writing `--fg` here, Latte's
    // green (2.75:1) and red (4.47:1) would be back on an 11.5px string — and
    // the tinted 36px slab would be back with them.
    const { status } = block();
    for (const property of ["fg", "bg", "bd"]) expect(cssVar(status, property)).toBe("");
    const dot = descendants(status).find((n) => n.className === "service__status-dot");
    expect(cssVar(dot as Element, "fill")).toBe("var(--success)");
  });
});
