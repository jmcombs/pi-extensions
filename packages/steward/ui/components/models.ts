/**
 * The rail's MODELS block.
 *
 * A card is a filter control and a container for a second control at once, so
 * it cannot be a `<button>` — it is a `role="button"` with the keyboard
 * handling written out, and the Load/Unload button inside it keeps both the
 * click and the key events it handles natively away from the card.
 *
 * The block header carries a single info legend for the whole list: a real
 * button that toggles a definitions panel, one entry per card field label
 * (`Quant`, `Context`, `KV Cache`, …), so the compact labeled grid can be read
 * once and understood.
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

/** One labeled cell of the body grid: its value span, patched per repaint. */
interface FieldCell {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
}

interface ModelRow {
  root: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  /** The seven body cells, in the fixed order the view model lists them. */
  cells: FieldCell[];
  button: HTMLButtonElement;
  vm: ModelCardVm | null;
}

/** Rows are recycled rather than keyed, so their ids only have to be unique. */
let rowSeq = 0;

/** How many labeled cells a card body always has, so the grid can be built once. */
const FIELD_COUNT = 7;

function createFieldCell(): FieldCell {
  const label = el("span", { class: "model-card__label" });
  const value = el("span", { class: "model-card__value" });
  return {
    root: el("div", { class: "model-card__field", children: [label, value] }),
    label,
    value,
  };
}

function createRow(handlers: ModelsHandlers): ModelRow {
  rowSeq += 1;
  const prefix = `steward-model-${rowSeq}`;
  const dot = el("span", { class: "model-card__dot" });
  const name = el("span", { class: "model-card__name", attrs: { id: `${prefix}-name` } });
  const cells = Array.from({ length: FIELD_COUNT }, createFieldCell);
  // The body grid is named as one group: the label set is identical on every
  // card, so a screen reader reading the whole grid's text (label + value, seven
  // times) is exactly what distinguishes this card, and no per-field id juggling
  // is needed as the values change.
  const fields = el("div", {
    class: "model-card__fields",
    attrs: { id: `${prefix}-fields` },
    children: cells.map((cell) => cell.root),
  });

  const row: ModelRow = {
    root: el("div", { class: "model-card" }),
    dot,
    name,
    cells,
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
  // The card is named from its own contents: the name and the body grid as a
  // whole. The label set is fixed and identical on every card, so this is stamped
  // once here rather than rebuilt each repaint.
  setAttr(row.root, "aria-labelledby", `${prefix}-name ${prefix}-fields`);
  // The Load/Unload button rides the header row with the name — the one row every
  // card always has, and the only place a transition is announced — so it sits in
  // the same place independent of the labeled grid below it.
  row.root.append(
    el("div", {
      class: "model-card__top",
      children: [el("div", { class: "model-card__title", children: [dot, name] }), row.button],
    }),
    fields,
  );
  return row;
}

/** The header info legend: one entry per card field, keyed by its exact label. */
const LEGEND_TERMS: readonly { term: string; def: string }[] = [
  {
    term: "Quant",
    def: "Weight quantization: how compressed the model's weights are. Fewer bits = smaller and faster, slightly less precise. 16-bit (F16) is uncompressed. Read from the loaded file; n/a until then.",
  },
  {
    term: "Size",
    def: "On-disk size, and roughly the VRAM it needs once loaded. Known only while loaded.",
  },
  {
    term: "Context",
    def: "Tokens each request slot gets: the loaded context window divided across the parallel slots (total ÷ slots). Known only while loaded.",
  },
  {
    term: "GPU Layers",
    def: "Transformer layers offloaded to the GPU (-ngl); more on the GPU is faster, 99 means all. This is the requested value — the effective count is never reported, so it reads n/a unless it was pinned at launch.",
  },
  {
    term: "Flash",
    def: "Flash Attention — an optimized attention kernel: faster, less memory. On / Off / Auto. Can stay Auto even loaded — the resolved value isn't reported back.",
  },
  {
    term: "KV Cache",
    def: "Precision of the runtime attention cache — the per-request memory that grows with context, separate from the weight size. 8-bit is compact; 16-bit is the default.",
  },
  {
    term: "Type",
    def: "Whether the model generates text (Generative) or produces embeddings (Embedder). Read from the router's modalities, so it's known even while unloaded.",
  },
];

/** localStorage key for whether the legend is left open across a page session. */
const LEGEND_STORAGE_KEY = "steward.legend";

/** Reads the remembered legend state; storage may be unavailable or blocked. */
function readLegendOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGEND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persists the legend state; a failure just means it is not remembered. */
function writeLegendOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(LEGEND_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // No storage (private mode, disabled): the in-memory state still holds.
  }
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

  const panelId = "steward-models-legend";
  const panel = el("div", {
    class: "legend-panel",
    attrs: { id: panelId, role: "group", "aria-label": "Field definitions", hidden: true },
    children: [
      el("dl", {
        class: "legend-list",
        children: LEGEND_TERMS.flatMap(({ term, def }) => [
          el("dt", { class: "legend-term", text: term }),
          el("dd", { class: "legend-def", text: def }),
        ]),
      }),
    ],
  });

  // A real button, not a hover affordance: it must be reachable and toggle-able
  // from the keyboard and legible to a screen reader, which a tooltip is not.
  let legendOpen = readLegendOpen();
  const legendToggle = el("button", {
    class: "legend-toggle",
    text: "ⓘ",
    attrs: {
      type: "button",
      "aria-label": "What these values mean",
      "aria-controls": panelId,
      // A string, not a boolean: `aria-expanded` is an enumerated ARIA value
      // ("true"/"false"), not an HTML boolean attribute, and setAttr would drop a
      // `false` entirely — leaving the state unspoken and the open-state style dead.
      "aria-expanded": String(legendOpen),
    },
  });

  const syncLegend = (): void => {
    setAttr(legendToggle, "aria-expanded", String(legendOpen));
    // `hidden` gives the panel zero height when collapsed, so it never pushes the
    // cards down the rail until the operator asks for it.
    setAttr(panel, "hidden", !legendOpen);
  };
  legendToggle.addEventListener("click", () => {
    legendOpen = !legendOpen;
    writeLegendOpen(legendOpen);
    syncLegend();
  });
  syncLegend();

  const root = el("section", {
    class: "rail__block rail__block--models",
    attrs: { "aria-labelledby": "steward-models-title" },
    children: [
      el("div", {
        class: "block__head",
        children: [
          el("h2", { class: "eyebrow", text: "Models", attrs: { id: "steward-models-title" } }),
          el("div", { class: "block__head-controls", children: [legendToggle, pill] }),
        ],
      }),
      panel,
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

        // The label set and order are fixed, so cell i always renders field i;
        // an `n/a` value carries `data-na="true"` so the stylesheet dims it while
        // the label beside it stays at full strength.
        model.fields.forEach((field, fieldIndex) => {
          const cell = row.cells[fieldIndex];
          if (cell === undefined) return;
          setText(cell.label, `${field.label}:`);
          setText(cell.value, field.value);
          setAttr(cell.value, "data-na", String(field.na));
        });

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
