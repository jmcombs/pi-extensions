/**
 * The whole of Steward's view layer's framework.
 *
 * Components build elements once and then patch them, so the helpers here are
 * split between construction (`el`, `svg`) and the guarded writers (`setText`,
 * `setVar`, `setAttr`) the update paths use. The guards matter: the metrics
 * poll runs every 1.6 s and the log stream faster than that, and writing a
 * property that has not changed is what turns a live dashboard into a
 * flickering one.
 */

export type Child = Node | string | null | undefined | false;

/** What every component in `./components/` hands back: a node and a patcher. */
export interface View<T> {
  el: HTMLElement;
  update(vm: T): void;
}

export interface ElementSpec {
  class?: string;
  text?: string;
  /** Plain HTML attributes. `false` removes the attribute. */
  attrs?: Record<string, string | number | boolean>;
  /** CSS custom properties, written without their leading dashes. */
  vars?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
  children?: Child[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (spec.class !== undefined) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) setAttr(node, name, value);
  }
  if (spec.vars) {
    for (const [name, value] of Object.entries(spec.vars)) setVar(node, name, value);
  }
  if (spec.on) {
    for (const [type, handler] of Object.entries(spec.on)) node.addEventListener(type, handler);
  }
  if (spec.children) append(node, spec.children);
  return node;
}

/** SVG needs its own namespace, and its attributes are not DOM properties. */
export function svg(
  tag: string,
  attrs: Record<string, string>,
  children: Element[] = [],
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.appendChild(child);
  return node;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/** Writes `text` only when it differs, so unchanged rows are never touched. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, name: string, value: string | number | boolean): void {
  if (value === false) {
    node.removeAttribute(name);
    return;
  }
  const next = value === true ? "" : String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

/** Sets a CSS custom property, named without its leading `--`. */
export function setVar(node: HTMLElement | SVGElement, name: string, value: string): void {
  const property = `--${name}`;
  if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
}

export function setStyle(node: HTMLElement, property: string, value: string): void {
  if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
}

/**
 * Grows or shrinks a list of row records so it is exactly `count` long,
 * mirroring the change into `parent`. Callers keep their own handles on the
 * pieces of each row, so patching a row afterwards costs no lookups.
 */
export function syncRows<R extends { root: HTMLElement }>(
  parent: HTMLElement,
  rows: R[],
  count: number,
  create: () => R,
): void {
  while (rows.length > count) {
    const extra = rows.pop();
    if (extra !== undefined) parent.removeChild(extra.root);
  }
  while (rows.length < count) {
    const row = create();
    rows.push(row);
    parent.appendChild(row.root);
  }
}
