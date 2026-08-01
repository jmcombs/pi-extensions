/**
 * A DOM small enough to run `ui/components/` in a Node test, and no larger.
 *
 * The components under test are patchers: they build elements once and then
 * write attributes, text and focus at them. The behaviour worth pinning —
 * whether the status chip is still a `role="status"` that is not a button, and
 * where focus lands when a control unmounts under it — is behaviour of THOSE
 * writes, so the test has to run the real component against something that
 * answers `getAttribute`, `contains`, `focus` and `activeElement` the way a
 * browser does.
 *
 * Deliberately not a DOM library: the surface `ui/dom.ts` touches is a dozen
 * members, and a dependency that pulls in a full HTML parser to check three
 * attributes would be a much larger thing to keep honest. Everything here is
 * spec behaviour or nothing: `contains(null)` is `false`, `contains(self)` is
 * `true`, focusing an element makes it `activeElement`, and removing the
 * focused element drops focus to the body — which is the exact browser rule the
 * components' focus-restore code exists to survive.
 *
 * Test-only. `package.json` keeps `__fixtures__` out of the published files.
 */

type Handler = (event: Event) => void;

class StubText {
  parentNode: StubElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }
}

type StubChild = StubElement | StubText;

/** Just enough of `CSSStyleDeclaration` for `setVar` and `setStyle`. */
class StubStyle {
  readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

class StubElement {
  readonly tagName: string;
  readonly childNodes: StubChild[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Handler[]>();
  readonly style = new StubStyle();
  className = "";
  parentNode: StubElement | null = null;
  document: StubDocument;

  constructor(tagName: string, document: StubDocument) {
    this.tagName = tagName;
    this.document = document;
  }

  get firstChild(): StubChild | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value !== "") this.appendChild(new StubText(value));
  }

  /** Buttons reflect the attribute as a property; the service block reads it. */
  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  appendChild<T extends StubChild>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends StubChild>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    // A browser does not keep focus on a node it has just detached; the
    // components' restore code is written against exactly this.
    if (child instanceof StubElement && child.contains(this.document.activeElement)) {
      this.document.activeElement = this.document.body;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(node: StubElement | null): boolean {
    for (let current = node; current !== null; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  focus(): void {
    this.document.activeElement = this;
  }

  addEventListener(type: string, handler: Handler): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  /** Fires the listeners registered for `type`. No bubbling: none is needed. */
  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ type } as unknown as Event);
  }
}

class StubDocument {
  activeElement: StubElement;
  readonly body: StubElement;

  constructor() {
    this.body = new StubElement("body", this);
    this.activeElement = this.body;
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createElementNS(_namespace: string, tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createTextNode(data: string): StubText {
    return new StubText(data);
  }
}

/** Every element at or under `root`, in document order. */
export function descendants(root: Element): Element[] {
  const found: Element[] = [];
  const stack: StubElement[] = [root as unknown as StubElement];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    found.push(node as unknown as Element);
    for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
      const child = node.childNodes[i];
      if (child instanceof StubElement) stack.push(child);
    }
  }
  return found;
}

/** The one element at or under `root` carrying `name="value"`. */
export function byAttribute(root: Element, name: string, value: string): Element {
  const found = descendants(root).find((node) => node.getAttribute(name) === value);
  if (found === undefined) throw new Error(`no element with ${name}="${value}"`);
  return found;
}

/** The one element at or under `root` whose class list contains `className`. */
export function byClass(root: Element, className: string): Element {
  const found = descendants(root).find((node) => node.className.split(" ").includes(className));
  if (found === undefined) throw new Error(`no element with class "${className}"`);
  return found;
}

/** The CSS custom property `--name` written on an element, or `""`. */
export function cssVar(element: Element, name: string): string {
  return (element as unknown as StubElement).style.getPropertyValue(`--${name}`);
}

/** What a test holds onto: the document it installed, and how to drive it. */
export interface StubDom {
  /** The element focus falls back to, exactly as `document.body` does. */
  body: HTMLElement;
  /** The currently focused element, or the body when nothing holds focus. */
  activeElement(): Element;
  /** Fires an element's `click` listeners. */
  click(element: Element): void;
  /** Restores whatever `globalThis.document` was before. */
  restore(): void;
}

/**
 * Installs the stub as `globalThis.document` and hands back the handle. Call
 * `restore()` in an `afterEach` so one test's document cannot outlive it.
 */
export function installStubDom(): StubDom {
  const previous = Reflect.get(globalThis, "document") as unknown;
  const document = new StubDocument();
  Reflect.set(globalThis, "document", document);
  return {
    body: document.body as unknown as HTMLElement,
    activeElement: () => document.activeElement as unknown as Element,
    click: (element) => {
      (element as unknown as StubElement).dispatch("click");
    },
    restore: () => {
      Reflect.set(globalThis, "document", previous);
    },
  };
}
