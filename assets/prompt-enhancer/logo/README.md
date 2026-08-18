# Prompt Enhancer — Logo

The mark is a shell **caret** with an **enhance sparkle**: a rough request being
refined. Wordmark is "Prompt Enhancer" in Manrope ExtraBold. Palette and type
follow the Netservant design system (same Path Blue / Manrope family as Headroom
and Steward).

## Files

**Vector (use these wherever possible — infinitely scalable)**

- `prompt-enhancer-mark.svg` — mark, inherits ink from `currentColor`, Path Blue spark. Default for web/README.
- `prompt-enhancer-mark-dark.svg` — mark pre-colored for dark/terminal backgrounds.
- `prompt-enhancer-mark-mono.svg` — single-color mark (all `currentColor`) for stamps, print, one-color contexts.
- `prompt-enhancer-lockup.svg` — horizontal mark + wordmark. Text is live — see [Wordmark](#wordmark).
- `prompt-enhancer-icon.svg` / `prompt-enhancer-icon-512.svg` — square app/marketplace icon, white on Path Blue, 114px corner radius on a 512 grid.
- `prompt-enhancer-icon-512.png` — raster of the tile for places that will not take SVG.
- `prompt-enhancer-favicon-32.svg` — simplified mark (underline bar dropped) for 16–32px.

**Raster / gallery (one level up)**

- `../preview.svg` / `../preview.png` — gallery card and root-README thumb (the Path Blue tile).
- `../banner.svg` / `../banner.png` — package README header (Path Blue card + white lockup).
- `../status-states.svg` — Powerline widget states used in the package README.

## Color

| Role | Light backgrounds | Dark backgrounds |
| --- | --- | --- |
| Caret + bar (ink) | `#4c4f69` | `#cdd6f4` |
| Spark (accent) | `#3465a4` Path Blue | `#8caaee` |
| Underline bar opacity | 0.40 | 0.35 |
| Surface (icon tile) | `#3465a4` with white mark | `#1e1e2e` with `#8caaee` spark |

The mark's caret and bar use `currentColor`, so in HTML it inherits the surrounding
text color; only the spark is hard-coded to the accent. Swap the accent to `#8caaee`
under `[data-theme="dark"]` / `prefers-color-scheme: dark`.

## Geometry (48×48 viewBox)

```
caret   path  M11 13 L23 24 L11 35   stroke-width 6, round cap + join
bar     rect  x26 y30 w15 h5.6 r2.8  fill ink @ 0.4
spark   path  M35 6 L37.4 12.6 L44 15 L37.4 17.4 L35 24 L32.6 17.4 L26 15 L32.6 12.6 Z
```

Do not rescale parts independently — scale the whole 48×48 box.

## Wordmark

- Font: **Manrope 800** (ExtraBold), `letter-spacing: -0.025em`, sentence case: "Prompt Enhancer".
- Color: ink (`#4c4f69` light / `#cdd6f4` dark). Never blue.
- Optional subline: `for the pi coding agent`, **JetBrains Mono**, uppercase, `letter-spacing: 0.14em`, 11px at a 30px wordmark, color `#7c7f93` (light) / `#9399b2` (dark).
- `prompt-enhancer-lockup.svg` keeps the text as a live `<text>` node. For distribution outside a Manrope-loaded page, convert it to outlines.

## Layout rules

- Lockup: mark height = wordmark cap-to-baseline height; gap between mark and wordmark = 22px at a 60px mark (≈0.37× mark height).
- Clear space on all sides: 25% of the mark's height.
- Minimum sizes: mark 16px, lockup 132px wide.
- At 16–20px use the favicon variant (bar dropped, caret and spark thickened) — the three-element mark muddies below 24px.
- The mark always sits left of the wordmark. No stacked/centered variant is specified.

## In-terminal glyph

No single Nerd Font glyph carries both the caret and the spark. Closest pairing,
matching the mark:

```
\ueab6\uec10    nf-cod-chevron-right + nf-cod-sparkle
```

That pair is the widget default (`PROMPT_ENHANCER_GLYPH`). On the Path Blue
Powerline brand block both glyphs render in paper (`#eff1f5`). Single-glyph
fallbacks if two glyphs are too wide: `\uf489` (`nf-oct-terminal`) or `\uebcf`
(`nf-cod-wand`). Set `PROMPT_ENHANCER_GLYPH=""` to drop the mark and keep the
wordmark.

## Don't

- Recolor the caret to blue, or the wordmark to blue.
- Add gradients, glows, or shadows — the system is flat.
- Rotate, outline, or reflow the spark; it stays a 4-point star at the caret's upper right.
- Place the light mark on the Path Blue tile — use the white icon variant.
