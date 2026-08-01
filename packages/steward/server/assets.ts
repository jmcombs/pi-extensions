/**
 * The static asset route.
 *
 * Steward has no build step: the browser modules are authored as TypeScript
 * and shipped as TypeScript. A request for `/ui/main.js` reads `ui/main.ts`
 * off disk and hands it to `node:module`'s `stripTypeScriptTypes`, which
 * blanks the type annotations in place and leaves runnable JavaScript. Because
 * only erasable syntax is allowed in `ui/` and `core/`, that is the whole
 * toolchain.
 *
 * Everything else (`.html`, `.css`, `.svg`) is served verbatim. Nothing is
 * cached: this is a live operator tool, and a stale module is worse than a
 * re-read.
 */

import { readFile, realpath } from "node:fs/promises";
// `stripTypeScriptTypes` landed in Node 22.13. Reaching it through a namespace
// import keeps a runtime without it from failing the module link, so the guard
// below can report the real requirement instead of a link error.
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One file, ready to write to the response. */
export interface Asset {
  body: string;
  contentType: string;
}

/**
 * Resolved from this module's own URL rather than `process.cwd()`, so the
 * routes work the same from the repo and from an installed npm package.
 */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const UI_ROOT = path.join(PACKAGE_ROOT, "ui");
const CORE_ROOT = path.join(PACKAGE_ROOT, "core");

const JAVASCRIPT = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const HTML = "text/html; charset=utf-8";
const SVG = "image/svg+xml";

const CONTENT_TYPES: Record<string, string | undefined> = {
  ".js": JAVASCRIPT,
  ".css": CSS,
  ".html": HTML,
  ".svg": SVG,
};

const NODE_REQUIREMENT =
  "Steward needs Node >= 22.13: this runtime has no node:module stripTypeScriptTypes(), " +
  "so the browser modules cannot be served.";

/**
 * Test sources ship inside the package but are not part of the dashboard.
 * Matches `format.test.js` and `format.test.ts` alike.
 */
const TEST_SOURCE = /\.test\.[^./]+$/;

interface ResolvedAsset {
  file: string;
  /** Directory the request was routed to; the file must resolve inside it. */
  root: string;
  contentType: string;
  /** Whether the file on disk is TypeScript that must be stripped first. */
  strip: boolean;
}

/**
 * Throws unless the host can strip TypeScript types. Defaults to this runtime,
 * and is called at server start so the requirement reaches the operator rather
 * than surfacing as a blank page once the shell asks for its first module.
 */
export function assertTypeStripping(host: { stripTypeScriptTypes?: unknown } = nodeModule): void {
  if (typeof host.stripTypeScriptTypes !== "function") throw new Error(NODE_REQUIREMENT);
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * The roots with every symlink already resolved, so the containment check
 * below compares like with like. Resolved once: they cannot move under a
 * running server. A root that cannot be resolved falls back to its lexical
 * path, which is the strictest answer available.
 */
const realRoots = new Map<string, Promise<string>>();

function realRoot(root: string): Promise<string> {
  const cached = realRoots.get(root);
  if (cached !== undefined) return cached;
  const pending = realpath(root).catch(() => root);
  realRoots.set(root, pending);
  return pending;
}

/**
 * Maps a request path to a file, or `null` when the path is not served.
 *
 * The lexical check here rejects traversal — including percent-encoded
 * segments, which are decoded first — before anything touches the disk.
 * Symlinks are dealt with in {@link readAsset}, where the real path is known.
 */
function resolveAsset(pathname: string): ResolvedAsset | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  if (decoded === "/" || decoded === "") {
    return {
      file: path.join(UI_ROOT, "index.html"),
      root: UI_ROOT,
      contentType: HTML,
      strip: false,
    };
  }
  if (decoded === "/favicon.svg") {
    return {
      file: path.join(UI_ROOT, "favicon.svg"),
      root: UI_ROOT,
      contentType: SVG,
      strip: false,
    };
  }

  const match = /^\/(ui|core)\/(.+)$/.exec(decoded);
  const area = match?.[1];
  const rest = match?.[2];
  if (rest === undefined) return null;
  if (TEST_SOURCE.test(rest)) return null;

  const extension = path.extname(rest);
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) return null;

  const root = area === "core" ? CORE_ROOT : UI_ROOT;
  // Import specifiers are written `.js` (NodeNext style); the source is `.ts`.
  const strip = extension === ".js";
  const file = path.resolve(root, strip ? `${rest.slice(0, -".js".length)}.ts` : rest);
  if (!isInside(root, file)) return null;

  return { file, root, contentType, strip };
}

function stripTypes(source: string): string {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") throw new Error(NODE_REQUIREMENT);
  // Default 'strip' mode only: it erases types without rewriting anything, so
  // line numbers survive and no source map is needed.
  return strip(source);
}

/** True for the errno codes that mean "there is no such file", not "it broke". */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/**
 * Reads the asset a request path maps to, or resolves `null` when the path is
 * unroutable or the file is absent — both of which the caller answers with a
 * 404.
 */
export async function readAsset(pathname: string): Promise<Asset | null> {
  const resolved = resolveAsset(pathname);
  if (resolved === null) return null;

  // `path.resolve` cannot see through a symlink but `readFile` follows one, so
  // containment is re-checked against the path the filesystem actually means.
  let file: string;
  try {
    file = await realpath(resolved.file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!isInside(await realRoot(resolved.root), file)) return null;

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  return {
    body: resolved.strip ? stripTypes(source) : source,
    contentType: resolved.contentType,
  };
}
