/**
 * A model's card color.
 *
 * The color is a deterministic function of the model id — a stable hash into a
 * fixed palette — so the same model is always the same color, across reloads and
 * regardless of whether it happens to be loaded right now. There is one
 * override: embedding models always take a reserved hue, so they read as a class
 * rather than as "whatever the hash landed on". The color says nothing about
 * what the model is used for; that was a fiction the old role field encoded.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

/**
 * The categorical palette, drawn from the design system's tokens. Blue is held
 * back for embedding models (see {@link EMBED_TOKEN}) so it never collides with
 * a hashed assignment.
 */
const PALETTE = [
  "--latte-mauve",
  "--latte-teal",
  "--latte-peach",
  "--latte-sapphire",
  "--latte-pink",
  "--latte-lavender",
  "--latte-yellow",
  "--latte-maroon",
] as const;

/** The hue reserved for embedding models. */
const EMBED_TOKEN = "--latte-blue";

/** A non-empty fallback so palette indexing never yields `undefined`. */
const FALLBACK_TOKEN = PALETTE[0];

/**
 * A stable 32-bit hash of a string (FNV-1a). Deterministic and dependency-free,
 * so a given id maps to the same palette slot on every run — the property the
 * whole color scheme rests on. `Math.imul` keeps the multiply in 32-bit range.
 */
function hash32(value: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * The CSS custom-property reference for a model's color, e.g.
 * `var(--latte-teal)`. Embedding models always get the reserved hue; every
 * other model is hashed into the palette by its id.
 */
export function modelColor(id: string, embedding: boolean): string {
  if (embedding) return `var(${EMBED_TOKEN})`;
  const token = PALETTE[hash32(id) % PALETTE.length] ?? FALLBACK_TOKEN;
  return `var(${token})`;
}
