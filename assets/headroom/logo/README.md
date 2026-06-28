# Headroom — Logo ("Raise the ceiling")

The mark is an upward arrow lifting a ceiling bar, with clear space opening between
them — the literal meaning of *headroom*: room created above. Built on the brand's
Path Blue and Manrope.

## Files

**Vector (use these wherever possible — infinitely scalable)**
- `headroom-mark.svg` — mark only, Path Blue, transparent background
- `headroom-mark-white.svg` — mark only, white (for dark backgrounds)
- `headroom-icon.svg` — app icon: white mark on a Path Blue rounded tile
- `favicon.svg` — same as the app icon, for `<link rel="icon">`
- `headroom-lockup.svg` — mark + "Headroom" wordmark (ink), for light backgrounds
- `headroom-lockup-white.svg` — mark + wordmark, white, for dark backgrounds

**Raster (PNG, for places SVG isn't accepted)**
- `headroom-icon-512.png` — app icon, 512×512
- `headroom-icon-180.png` — Apple touch icon, 180×180
- `favicon-32.png`, `favicon-16.png` — browser favicons
- `headroom-mark-512.png` — mark only, Path Blue, transparent
- `headroom-mark-white-512.png` — mark only, white, transparent

## Color

- **Path Blue** `#3465a4` — the mark, the icon tile, primary accent
- **Ink** `#4c4f69` — the "Headroom" wordmark on light backgrounds
- **Paper** `#eff1f5` — the wordmark / mark on dark backgrounds
- Icon tile corner radius is ~23% of the tile (rx 15 on a 64 grid).

## Type

The wordmark is **Manrope, weight 800**, letter-spacing **-0.03em**, in Ink `#4c4f69`.
Load Manrope from Google Fonts (weights 400–800). The `.svg` lockups reference
Manrope by name; if you build the lockup in code instead, use the snippet below so the
text is real, selectable, and always crisp.

```html
<a class="headroom-logo" href="/">
  <img src="headroom-mark.svg" alt="" width="34" height="34">
  <span>Headroom</span>
</a>
```
```css
.headroom-logo{ display:inline-flex; align-items:center; gap:10px; text-decoration:none; }
.headroom-logo span{
  font-family:'Manrope',sans-serif; font-weight:800;
  font-size:26px; letter-spacing:-0.03em; color:#4c4f69;
}
/* On a dark surface: swap to headroom-mark-white.svg and color:#eff1f5 */
```

## Usage

- **Clear space:** keep padding equal to the height of the ceiling bar (≈ the mark's
  top stroke) on all sides of the mark; for the lockup, keep at least the mark's width
  of clear space to its left and right.
- **Minimum size:** mark no smaller than 16px; lockup no smaller than ~110px wide.
- **Backgrounds:** use the Path Blue (or white) mark on light surfaces; use the white
  mark / white lockup on dark surfaces or photos. Don't place the blue mark on a
  busy or low-contrast background.
- **Don't:** recolor the mark outside the palette, add gradients/shadows to the glyph
  itself, rotate it, stretch it, or rebuild the wordmark in another typeface.
