/** The rail's CONFIG block: how the server was launched, read-only. */

import type { ConfigEntry } from "../../core/types.js";
import type { View } from "../dom.js";
import { el, setText, syncRows } from "../dom.js";

interface ConfigRow {
  root: HTMLElement;
  key: HTMLElement;
  value: HTMLElement;
}

function createRow(): ConfigRow {
  const key = el("span", { class: "config-row__key" });
  const value = el("span", { class: "config-row__value" });
  return { root: el("div", { class: "config-row", children: [key, value] }), key, value };
}

export function createConfigBlock(): View<ConfigEntry[]> {
  const rows: ConfigRow[] = [];
  const list = el("div", { class: "config-list" });
  const root = el("section", {
    class: "rail__block rail__block--config",
    attrs: { "aria-labelledby": "steward-config-title" },
    children: [
      el("h2", { class: "eyebrow", text: "Config", attrs: { id: "steward-config-title" } }),
      list,
    ],
  });

  return {
    el: root,
    update(entries) {
      syncRows(list, rows, entries.length, createRow);
      entries.forEach((entry, index) => {
        const row = rows[index];
        if (row === undefined) return;
        setText(row.key, entry.key);
        setText(row.value, entry.value);
      });
    },
  };
}
