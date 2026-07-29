/**
 * The rail's SERVICE block — the "Steward" box.
 *
 * Four stacked zones: the brand lockup, a status indicator (the service is
 * `started` / `stopped`), the control row, and the router facts folded in from
 * what used to be a separate CONFIG block. The status indicator is deliberately
 * not a button: it reports state and nothing more, so it is a `role="status"`
 * region that a screen reader announces when the state changes.
 *
 * The control row holds only actions this machine actually has a consented
 * command for; with none, one setup affordance takes its place. Stop and
 * restart never fire from a single click — they open an inline confirm strip
 * that names what will be unloaded, moves focus to Cancel, and closes on Esc.
 * A command that failed leaves an alert here rather than nothing at all.
 */

import type { ServiceControlVm, ServiceVm } from "../../core/select.js";
import type { ServiceAction } from "../../core/types.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, svg, syncRows } from "../dom.js";

export interface ServiceHandlers {
  onToggleTheme: () => void;
  /** Runs an action now: a non-disruptive one, or one already confirmed. */
  onService: (action: ServiceAction) => void;
  /** Asks for the confirm strip before a disruptive action. */
  onConfirmService: (action: ServiceAction) => void;
  /** Dismisses the confirm strip without acting. */
  onCancelService: () => void;
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

/**
 * One control button. The action and whether it needs confirming live on the
 * record rather than in the closure, so a row can be reused across repaints
 * when the available set changes without rebinding its listener.
 */
interface ControlRow {
  root: HTMLButtonElement;
  action: ServiceAction;
  confirms: boolean;
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
  // Not a <button>: it reports state and nothing more, so it takes no hover and
  // no click. `tabindex="-1"` keeps it out of the tab order while still letting
  // the confirm flow park focus here when the button it came from went inert.
  const status = el("div", {
    class: "service__status",
    attrs: { role: "status", "aria-live": "polite", tabindex: "-1" },
    children: [statusDot, statusLabel],
  });
  const theme = el("button", {
    class: "btn btn--icon",
    attrs: { type: "button" },
    on: { click: handlers.onToggleTheme },
  });

  const controls = el("div", {
    class: "service__controls",
    attrs: { role: "group", "aria-label": "Service control" },
  });
  const controlRows: ControlRow[] = [];
  function createControlRow(): ControlRow {
    const row: ControlRow = {
      root: el("button", { class: "btn btn--sm service__control", attrs: { type: "button" } }),
      action: "start",
      confirms: false,
    };
    row.root.addEventListener("click", () => {
      if (row.confirms) handlers.onConfirmService(row.action);
      else handlers.onService(row.action);
    });
    return row;
  }

  // Not a button: the dashboard cannot run a Pi command, and a control that
  // does nothing is worse than a sentence that says what to do.
  const setupLabel = el("p", { class: "service__setup-label" });
  const setupDetail = el("p", { class: "service__setup-detail" });
  const setupCommand = el("code", { class: "service__setup-command" });
  const setup = el("div", {
    class: "service__setup",
    attrs: { hidden: true },
    children: [setupLabel, setupDetail, setupCommand],
  });

  const confirmText = el("p", { class: "service__confirm-text" });
  const confirmCancel = el("button", {
    class: "btn btn--sm",
    attrs: { type: "button" },
    on: { click: handlers.onCancelService },
  });
  const confirmAccept = el("button", {
    class: "btn btn--sm service__control",
    attrs: { type: "button", "data-tone": "danger" },
  });
  let confirmAction: ServiceAction | null = null;
  confirmAccept.addEventListener("click", () => {
    if (confirmAction !== null) handlers.onService(confirmAction);
  });
  const confirm = el("div", {
    class: "service__confirm",
    attrs: { role: "group", "aria-label": "Confirm service action", hidden: true },
    children: [
      confirmText,
      el("div", { class: "service__confirm-row", children: [confirmCancel, confirmAccept] }),
    ],
  });
  // Esc backs out from anywhere inside the strip — focus is on Cancel when it
  // opens, so the escape hatch is one key away without a pointer.
  confirm.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Escape") handlers.onCancelService();
  });

  // A failed command is an operator-relevant event, not a status update, so it
  // announces assertively rather than waiting behind the polite region. It is
  // focusable programmatically (never by Tab) so the confirm flow can hand
  // focus to the outcome when the button that started it has gone inert.
  const notice = el("p", {
    class: "service__notice",
    attrs: { role: "alert", hidden: true, tabindex: "-1" },
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
      controls,
      setup,
      confirm,
      notice,
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

      const { controls: cvm } = vm;
      setAttr(controls, "hidden", cvm.buttons.length === 0);
      // The row is busy as a whole while a command is out: its buttons are
      // disabled, and assistive tech is told why rather than finding them inert.
      setAttr(controls, "aria-busy", cvm.pending ? "true" : "false");
      syncRows(controls, controlRows, cvm.buttons.length, createControlRow);
      cvm.buttons.forEach((button: ServiceControlVm, index) => {
        const row = controlRows[index];
        if (row === undefined) return;
        row.action = button.action;
        row.confirms = button.confirms;
        setText(row.root, button.label);
        setAttr(row.root, "disabled", button.disabled);
        setAttr(row.root, "aria-label", button.ariaLabel);
        setAttr(row.root, "title", button.disabledReason === "" ? false : button.disabledReason);
        setAttr(row.root, "data-tone", button.danger ? "danger" : "neutral");
      });

      setAttr(setup, "hidden", cvm.setup === null);
      if (cvm.setup !== null) {
        setText(setupLabel, cvm.setup.label);
        setText(setupDetail, cvm.setup.detail);
        setText(setupCommand, cvm.setup.command);
      }

      const wasConfirming = confirmAction;
      // Read before the strip is hidden: hiding an ancestor drops the focus.
      const focusWasInStrip = confirm.contains(document.activeElement);
      confirmAction = cvm.confirm?.action ?? null;
      setAttr(confirm, "hidden", cvm.confirm === null);
      if (cvm.confirm !== null) {
        setText(confirmText, cvm.confirm.consequence);
        setText(confirmCancel, cvm.confirm.cancelLabel);
        setText(confirmAccept, cvm.confirm.confirmLabel);
        setAttr(confirmAccept, "aria-label", cvm.confirm.confirmAriaLabel);
        // Opening moves focus to the safe choice, so a keyboard operator lands
        // on Cancel and has to travel to confirm — never the other way round.
        if (wasConfirming === null) confirmCancel.focus();
      }
      // Closing is where focus is most easily lost: accepting disables every
      // button while the command is out, so the opener is usually inert by the
      // time we get here. Resolve it after the notice is patched, and land on
      // the outcome — the alert if there is one, else the status readout —
      // rather than dropping a keyboard operator at the top of the document.
      const restoreFrom = cvm.confirm === null && wasConfirming !== null && focusWasInStrip;

      setAttr(notice, "hidden", cvm.notice === null);
      if (cvm.notice !== null) setText(notice, cvm.notice);

      if (restoreFrom) {
        const opener = controlRows.find((row) => row.action === wasConfirming);
        if (opener !== undefined && !opener.root.disabled) opener.root.focus();
        else if (cvm.notice !== null) notice.focus();
        else status.focus();
      }

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
