/**
 * The rail's MODELS block.
 *
 * A card is a filter control and a container for a second control at once, so
 * it cannot be a `<button>` — it is a `role="button"` with the keyboard
 * handling written out, and the Load/Unload button inside it keeps both the
 * click and the key events it handles natively away from the card.
 */

import type { ModelCardVm, PillVm } from "../../core/select.js";
import type { ModelAction } from "../../core/types.js";
import type { View } from "../dom.js";
import { el, setAttr, setText, setVar, syncRows } from "../dom.js";

export interface ModelsVm {
  models: ModelCardVm[];
  allLogsPill: PillVm;
}

export interface ModelsHandlers {
  onFilterModel: (modelId: string) => void;
  onShowAllLogs: () => void;
  onModelAction: (modelId: string, action: ModelAction) => void;
}

interface ModelRow {
  root: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  tuning: HTMLElement;
  status: HTMLElement;
  button: HTMLButtonElement;
  vm: ModelCardVm | null;
}

/** Rows are recycled rather than keyed, so their ids only have to be unique. */
let rowSeq = 0;

function createRow(handlers: ModelsHandlers): ModelRow {
  rowSeq += 1;
  const prefix = `steward-model-${rowSeq}`;
  const dot = el("span", { class: "model-card__dot" });
  const name = el("span", { class: "model-card__name", attrs: { id: `${prefix}-name` } });
  const meta = el("div", { class: "model-card__meta", attrs: { id: `${prefix}-meta` } });
  const tuning = el("div", { class: "model-card__tune", attrs: { id: `${prefix}-tune` } });
  const status = el("span", { class: "model-card__status", attrs: { id: `${prefix}-status` } });

  const row: ModelRow = {
    root: el("div", { class: "model-card" }),
    dot,
    name,
    meta,
    tuning,
    status,
    button: el("button", { class: "btn btn--filled btn--sm", attrs: { type: "button" } }),
    vm: null,
  };

  row.button.addEventListener("click", (event) => {
    // Without this the card underneath would also take the click and toggle
    // the log filter every time the operator loads a model.
    event.stopPropagation();
    if (row.vm !== null) handlers.onModelAction(row.vm.id, row.vm.buttonAction);
  });

  const filter = (): void => {
    if (row.vm !== null) handlers.onFilterModel(row.vm.id);
  };
  row.root.addEventListener("click", filter);
  row.root.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    // Enter and Space belong to the Load/Unload button while it holds focus:
    // taking them here would preventDefault() its native activation and filter
    // the log instead of loading the model.
    if (event.target !== row.root) return;
    // A held key repeats; a real button would still have fired exactly once.
    if (event.repeat) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    filter();
  });

  setAttr(row.root, "role", "button");
  setAttr(row.root, "tabindex", "0");
  // Naming the card from its own contents rather than with an aria-label is
  // what keeps the quant, size, context and rate audible; the label would have
  // replaced all of them. The card's action is described instead.
  setAttr(
    row.root,
    "aria-labelledby",
    `${prefix}-name ${prefix}-meta ${prefix}-tune ${prefix}-status`,
  );
  row.root.append(
    el("div", { class: "model-card__title", children: [dot, name] }),
    meta,
    tuning,
    el("div", { class: "model-card__foot", children: [status, row.button] }),
  );
  return row;
}

export function createModelsBlock(handlers: ModelsHandlers): View<ModelsVm> {
  const rows: ModelRow[] = [];
  const list = el("div", { class: "model-list" });
  const pill = el("button", {
    class: "pill",
    attrs: { type: "button" },
    text: "all logs",
    on: { click: handlers.onShowAllLogs },
  });

  const root = el("section", {
    class: "rail__block rail__block--models",
    attrs: { "aria-labelledby": "steward-models-title" },
    children: [
      el("div", {
        class: "block__head",
        children: [
          el("h2", { class: "eyebrow", text: "Models", attrs: { id: "steward-models-title" } }),
          pill,
        ],
      }),
      list,
    ],
  });

  return {
    el: root,
    update(vm) {
      setVar(pill, "bg", vm.allLogsPill.background);
      setVar(pill, "fg", vm.allLogsPill.color);
      setVar(pill, "bd", vm.allLogsPill.borderColor);
      setAttr(pill, "aria-pressed", String(vm.allLogsPill.active));

      syncRows(list, rows, vm.models.length, () => createRow(handlers));
      vm.models.forEach((model, index) => {
        const row = rows[index];
        if (row === undefined) return;
        row.vm = model;
        setVar(row.root, "bg", model.cardBackground);
        setVar(row.root, "bd", model.cardBorder);
        setAttr(row.root, "aria-pressed", String(model.selected));
        setAttr(row.root, "title", `Filter the log to ${model.short}`);
        setVar(row.dot, "model-color", model.color);
        setText(row.name, model.short);
        setText(row.meta, model.meta);
        setText(row.tuning, model.tuning);
        // Unloaded models have no preset tuning to show; the view model returns
        // an empty string, and hiding the row keeps its 9px gap from opening up
        // between the meta line and the footer.
        setAttr(row.tuning, "hidden", model.tuning === "");
        setText(row.status, model.footerLabel);
        setVar(row.status, "fg", model.footerColor);
        setText(row.button, model.buttonLabel);
        setVar(row.button, "bg", model.buttonBackground);
        setVar(row.button, "fg", model.buttonColor);
        setVar(row.button, "bd", model.buttonBorder);
        setAttr(row.button, "disabled", model.pending);
        setAttr(row.button, "aria-label", `${model.buttonLabel} ${model.short}`);
      });
    },
  };
}
