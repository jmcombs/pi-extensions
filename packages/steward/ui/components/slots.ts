/** The slots strip: what each parallel slot of the server is holding. */

import type { SlotsVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { el, setText, setVar, syncRows } from "../dom.js";

interface SlotCard {
  root: HTMLElement;
  id: HTMLElement;
  state: HTMLElement;
  model: HTMLElement;
  detail: HTMLElement;
}

function createCard(): SlotCard {
  const id = el("span", { class: "slot__id" });
  const state = el("span", { class: "slot__state" });
  const model = el("span", { class: "slot__model" });
  const detail = el("span", { class: "slot__detail" });
  const root = el("div", {
    class: "slot",
    children: [el("div", { class: "slot__head", children: [id, state] }), model, detail],
  });
  return { root, id, state, model, detail };
}

export function createSlotsStrip(): View<SlotsVm> {
  const cards: SlotCard[] = [];
  const summary = el("span", { class: "slots__summary" });
  const grid = el("div", { class: "slots__grid" });

  const root = el("section", {
    class: "slots",
    attrs: { "aria-labelledby": "steward-slots-title" },
    children: [
      el("div", {
        class: "slots__head",
        children: [
          el("h2", { class: "eyebrow", text: "Slots", attrs: { id: "steward-slots-title" } }),
          summary,
        ],
      }),
      grid,
    ],
  });

  return {
    el: root,
    update(vm) {
      setText(summary, vm.summary);
      syncRows(grid, cards, vm.cards.length, createCard);
      vm.cards.forEach((slot, index) => {
        const card = cards[index];
        if (card === undefined) return;
        setText(card.id, slot.label);
        setText(card.state, slot.state);
        setVar(card.state, "bg", slot.stateBackground);
        setVar(card.state, "fg", slot.stateColor);
        setText(card.model, slot.modelLabel);
        setVar(card.model, "model-color", slot.modelColor);
        setText(card.detail, slot.detail);
      });
    },
  };
}
