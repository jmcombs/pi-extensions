/**
 * The log console.
 *
 * Lines arrive faster than the metrics poll, so the console never rebuilds:
 * rows that have fallen out of the window are removed from the front, new ones
 * are appended, and the rest are patched in place. Only a change that genuinely
 * reorders the window — a filter moving under us, or a fold opening — falls
 * back to a rebuild.
 *
 * It is deliberately NOT a live region. A tail that announced itself would read
 * every arriving line aloud forever; what matters about the stream is announced
 * through the page's status line instead, once per state change.
 */

import type {
  ConsoleActionVm,
  ConsoleBannerVm,
  ConsoleNoticeVm,
  ConsoleVm,
  LogRowVm,
} from "../../core/select.js";
import { consoleFocusRestore, countNewLines } from "../../core/select.js";
import type { View } from "../dom.js";
import { clear, el, setAttr, setStyle, setText, setVar, syncRows } from "../dom.js";

export interface ConsoleHandlers {
  /**
   * Toggles one args fold, keyed by the run's first `seq`. `forced` says the
   * fold is held open by the active query, so the press changes only what
   * happens once that query clears.
   */
  onFold: (seq: number, forced: boolean, count: number) => void;
  /** The button inside a notice or banner: clear filters, show all models. */
  onAction: (kind: ConsoleActionVm["kind"]) => void;
}

/** How close to the bottom still counts as following the tail, in pixels. */
const FOLLOW_THRESHOLD_PX = 24;

interface LogRow {
  root: HTMLElement;
  key: string;
  seq: number;
  /** The run key this row toggles; only meaningful on a fold row. */
  foldSeq: number;
  foldForced: boolean;
  foldCount: number;
  fold: boolean;
  ts: HTMLElement;
  level: HTMLElement;
  model: HTMLElement;
  message: HTMLElement;
}

interface BannerRow {
  root: HTMLElement;
  text: HTMLElement;
  detail: HTMLElement;
  action: HTMLButtonElement;
  kind: ConsoleActionVm["kind"];
}

export function createLogConsole(handlers: ConsoleHandlers): View<ConsoleVm> {
  const rendered: LogRow[] = [];
  const topBanners: BannerRow[] = [];
  const bottomBanners: BannerRow[] = [];

  const heading = el("h2", { class: "visually-hidden" });
  const top = el("div", { class: "console__banners console__banners--top" });
  const rows = el("div", { class: "console__rows" });
  const bottom = el("div", { class: "console__banners console__banners--bottom" });

  const noticeGlyph = el("span", {
    class: "console__notice-glyph",
    attrs: { "aria-hidden": "true" },
  });
  const noticeTitle = el("p", { class: "console__notice-title" });
  const noticeDetail = el("p", { class: "console__notice-detail" });
  const noticeAction = el("button", {
    class: "btn btn--sm console__notice-action",
    attrs: { type: "button" },
  });
  const notice = el("div", {
    class: "console__notice",
    children: [el("p", { class: "console__notice-head", children: [noticeGlyph, noticeTitle] })],
  });
  notice.append(noticeDetail, noticeAction);
  // Hidden until the first paint decides otherwise: an empty notice box between
  // page load and the first snapshot is a claim about a console nobody has
  // looked at yet.
  setStyle(notice, "display", "none");
  let noticeKind: ConsoleActionVm["kind"] = "clear-filters";
  noticeAction.addEventListener("click", () => {
    handlers.onAction(noticeKind);
  });

  const jump = el("button", {
    class: "console__jump",
    attrs: { type: "button", hidden: true },
  });

  const root = el("div", {
    class: "console",
    attrs: {
      role: "region",
      "aria-label": "Server log",
      tabindex: "0",
    },
    children: [heading, top, notice, rows, bottom, jump],
  });

  // Follow-state: soft, and distinct from the hard Pause button. Scrolling up
  // holds the view while the buffer keeps filling; scrolling back to the bottom
  // resumes the tail on its own.
  let following = true;
  /** The newest seq on screen when following was lost, so "N new" is countable. */
  let pinnedSeq = Number.NEGATIVE_INFINITY;
  let newCount = 0;

  function paintJump(): void {
    const show = !following && newCount > 0;
    setAttr(jump, "hidden", !show);
    if (!show) return;
    const label = `Jump to latest · ${newCount} new`;
    setText(jump, label);
    setAttr(
      jump,
      "aria-label",
      `Jump to latest — ${newCount} new line${newCount === 1 ? "" : "s"}`,
    );
  }

  function toBottom(): void {
    // An instant jump, never a smooth scroll: this fires on every append, and a
    // smooth one would be motion an operator did not ask for.
    root.scrollTop = root.scrollHeight;
  }

  root.addEventListener("scroll", () => {
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < FOLLOW_THRESHOLD_PX;
    if (atBottom === following) return;
    following = atBottom;
    if (following) {
      newCount = 0;
      pinnedSeq = Number.NEGATIVE_INFINITY;
    } else {
      pinnedSeq = rendered.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
    }
    paintJump();
  });

  jump.addEventListener("click", () => {
    following = true;
    newCount = 0;
    pinnedSeq = Number.NEGATIVE_INFINITY;
    paintJump();
    toBottom();
  });

  function createRow(fold: boolean): LogRow {
    const ts = el("span", { class: "log-row__ts" });
    const level = el("span", { class: "log-row__level" });
    const model = el("span", { class: "log-row__model" });
    const message = el("span", { class: "log-row__msg" });
    const children = [ts, level, model, message];
    const row: LogRow = {
      root: fold
        ? el("button", { class: "log-row log-row--fold", attrs: { type: "button" }, children })
        : el("div", { class: "log-row", children }),
      key: "",
      seq: -1,
      foldSeq: -1,
      foldForced: false,
      foldCount: 0,
      fold,
      ts,
      level,
      model,
      message,
    };
    if (fold) {
      row.root.addEventListener("click", () => {
        handlers.onFold(row.foldSeq, row.foldForced, row.foldCount);
      });
    }
    return row;
  }

  function paint(row: LogRow, line: LogRowVm): void {
    row.key = line.key;
    row.seq = line.seq;
    setText(row.ts, line.time);
    setText(row.level, line.level);
    setText(row.model, line.model);
    setVar(row.model, "model-color", line.modelColor);
    setAttr(row.model, "data-scope", line.scope);
    setAttr(row.model, "title", line.modelTitle === "" ? false : line.modelTitle);
    setText(row.message, line.message);
    // Severity is carried by `data-level` in CSS — a filled badge for WARN and
    // ERROR against a plain token for INFO and DEBUG — so it is a difference in
    // shape, not only in hue.
    setAttr(row.root, "data-level", line.level);
    setAttr(row.root, "data-kind", line.kind);
    setAttr(row.root, "data-fold", line.folded ? "member" : false);
    if (line.fold !== null) {
      row.foldSeq = line.fold.seq;
      row.foldForced = line.fold.forced;
      row.foldCount = line.fold.count;
      setAttr(row.root, "aria-expanded", String(line.fold.expanded));
      setAttr(row.root, "aria-label", line.fold.ariaLabel);
    }
  }

  function createBanner(): BannerRow {
    const text = el("span", { class: "console__banner-text" });
    const detail = el("span", { class: "console__banner-detail" });
    const action = el("button", {
      class: "btn btn--sm console__banner-action",
      attrs: { type: "button" },
    });
    const banner: BannerRow = {
      root: el("div", { class: "console__banner", children: [text, detail, action] }),
      text,
      detail,
      action,
      kind: "clear-filters",
    };
    action.addEventListener("click", () => {
      handlers.onAction(banner.kind);
    });
    return banner;
  }

  function paintBanner(row: BannerRow, vm: ConsoleBannerVm): void {
    setText(row.text, vm.text);
    setText(row.detail, vm.detail);
    setAttr(row.detail, "hidden", vm.detail === "");
    setAttr(row.root, "data-tone", vm.tone);
    if (vm.action === null) {
      setAttr(row.action, "hidden", true);
      return;
    }
    row.kind = vm.action.kind;
    setAttr(row.action, "hidden", false);
    setText(row.action, vm.action.label);
    setAttr(row.action, "aria-label", vm.action.ariaLabel);
  }

  function paintNotice(vm: ConsoleNoticeVm | null): void {
    setStyle(notice, "display", vm === null ? "none" : "grid");
    if (vm === null) return;
    setAttr(notice, "data-tone", vm.tone);
    setAttr(notice, "data-state", vm.state);
    setText(noticeGlyph, vm.glyph);
    setText(noticeTitle, vm.title);
    setText(noticeDetail, vm.detail);
    if (vm.action === null) {
      setAttr(noticeAction, "hidden", true);
      return;
    }
    noticeKind = vm.action.kind;
    setAttr(noticeAction, "hidden", false);
    setText(noticeAction, vm.action.label);
    setAttr(noticeAction, "aria-label", vm.action.ariaLabel);
  }

  return {
    el: root,
    update(vm) {
      // Read before anything is patched: once the element is gone,
      // `document.activeElement` is the body and the trail is cold.
      const active = document.activeElement;
      const focusWasInside = active instanceof HTMLElement && root.contains(active);
      const activeFoldKey = focusWasInside
        ? (rendered.find((row) => row.fold && row.root === active)?.key ?? null)
        : null;

      setText(heading, vm.heading);
      paintNotice(vm.notice);

      const above = vm.banners.filter((banner) => banner.placement === "top");
      const below = vm.banners.filter((banner) => banner.placement === "bottom");
      syncRows(top, topBanners, above.length, createBanner);
      above.forEach((banner, index) => {
        const row = topBanners[index];
        if (row !== undefined) paintBanner(row, banner);
      });
      syncRows(bottom, bottomBanners, below.length, createBanner);
      below.forEach((banner, index) => {
        const row = bottomBanners[index];
        if (row !== undefined) paintBanner(row, banner);
      });

      const lines = vm.lines;
      const head = lines[0];
      let structureChanged = false;

      // Retire rows that have scrolled out of the window.
      while (rendered.length > 0) {
        const first = rendered[0];
        if (first === undefined) break;
        if (head !== undefined && first.seq >= head.seq) break;
        rows.removeChild(first.root);
        rendered.shift();
        structureChanged = true;
      }

      // If what is left no longer lines up with the window, the filter moved
      // under us — or a fold opened, which reshapes the run in place — and an
      // in-place patch would put the wrong element on screen. Keys, not
      // sequence numbers, because a fold row and the first line of its run
      // share a `seq`.
      const aligned =
        rendered.length <= lines.length && rendered.every((row, i) => lines[i]?.key === row.key);
      if (!aligned) {
        clear(rows);
        rendered.length = 0;
        structureChanged = true;
      }

      for (let i = rendered.length; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) break;
        const row = createRow(line.fold !== null);
        rendered.push(row);
        rows.appendChild(row.root);
        structureChanged = true;
      }

      lines.forEach((line, index) => {
        const row = rendered[index];
        if (row !== undefined) paint(row, line);
      });

      newCount = following ? 0 : countNewLines(lines, pinnedSeq);
      paintJump();

      // The browser blurs synchronously when the focused element is removed OR
      // when an ancestor turns `display: none`, so "the active element moved
      // while we were patching" catches all three cases without guessing at
      // layout — the notice is hidden, not removed, and the banner is removed.
      const restore = consoleFocusRestore(
        focusWasInside && document.activeElement !== active,
        activeFoldKey,
        rendered.map((row) => row.key),
      );
      if (restore.target === "fold") {
        rendered.find((row) => row.key === restore.key)?.root.focus();
      } else if (restore.target === "region") {
        root.focus();
      }

      // A live tail follows the newest line, but only while the operator is
      // actually at the bottom: a poll that changed nothing must not yank the
      // view, and neither must an append while they are reading further up.
      if (structureChanged && following && !vm.paused) toBottom();
    },
  };
}
