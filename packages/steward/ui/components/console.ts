/**
 * The log console.
 *
 * Lines arrive faster than the metrics poll, so the console never rebuilds:
 * rows that have fallen out of the window are removed from the front, new ones
 * are appended, and the rest are patched in place. Only a filter change that
 * genuinely reorders the window falls back to a rebuild.
 */

import type { LogRowVm } from "../../core/select.js";
import type { View } from "../dom.js";
import { clear, el, setText, setVar } from "../dom.js";

export interface ConsoleVm {
  lines: LogRowVm[];
  paused: boolean;
}

interface LogRow {
  root: HTMLElement;
  seq: number;
  ts: HTMLElement;
  level: HTMLElement;
  model: HTMLElement;
  message: HTMLElement;
}

function createRow(): LogRow {
  const ts = el("span", { class: "log-row__ts" });
  const level = el("span", { class: "log-row__level" });
  const model = el("span", { class: "log-row__model" });
  const message = el("span", { class: "log-row__msg" });
  const root = el("div", { class: "log-row", children: [ts, level, model, message] });
  return { root, seq: -1, ts, level, model, message };
}

export function createLogConsole(): View<ConsoleVm> {
  const rendered: LogRow[] = [];
  const empty = el("div", { class: "console__empty", text: "No lines match the current filter." });

  // A tail that announced itself would read every arriving line aloud forever,
  // so the console is a plain region — `role="log"` carries a live-region value
  // of its own that `aria-live="off"` only ambiguously cancels. What matters
  // about the stream is announced through the page's status line instead.
  const root = el("div", {
    class: "console",
    attrs: {
      role: "region",
      "aria-label": "Server log",
      tabindex: "0",
    },
  });

  function paint(row: LogRow, line: LogRowVm): void {
    row.seq = line.seq;
    setText(row.ts, line.time);
    setText(row.level, line.level);
    setVar(row.level, "level-color", line.levelColor);
    setText(row.model, line.model);
    setVar(row.model, "model-color", line.modelColor);
    setText(row.message, line.message);
  }

  return {
    el: root,
    update(vm) {
      const lines = vm.lines;
      const head = lines[0];
      let structureChanged = false;

      // Retire rows that have scrolled out of the window.
      while (rendered.length > 0) {
        const first = rendered[0];
        if (first === undefined) break;
        if (head !== undefined && first.seq >= head.seq) break;
        root.removeChild(first.root);
        rendered.shift();
        structureChanged = true;
      }

      // If what is left no longer lines up with the window, the filter moved
      // under us and an in-place patch would show the wrong lines.
      const aligned =
        rendered.length <= lines.length && rendered.every((row, i) => lines[i]?.seq === row.seq);
      if (!aligned) {
        clear(root);
        rendered.length = 0;
        structureChanged = true;
      }

      if (lines.length === 0) {
        if (empty.parentNode === null) root.appendChild(empty);
      } else if (empty.parentNode !== null) {
        root.removeChild(empty);
      }

      for (let i = rendered.length; i < lines.length; i += 1) {
        const row = createRow();
        rendered.push(row);
        root.appendChild(row.root);
        structureChanged = true;
      }

      lines.forEach((line, index) => {
        const row = rendered[index];
        if (row !== undefined) paint(row, line);
      });

      // A live tail follows the newest line: every append pins the view to the
      // bottom, wherever the operator had scrolled to, and Pause is the way to
      // hold the buffer still. Only the appends do it, though — a poll that
      // changed nothing must not yank the view.
      if (structureChanged && !vm.paused) root.scrollTop = root.scrollHeight;
    },
  };
}
