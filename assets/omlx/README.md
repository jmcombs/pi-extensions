# oMLX for Pi — gallery asset

The product name is **oMLX for Pi**. oMLX is a separate open-source project. This
extension is unofficial and is not affiliated with or endorsed by oMLX. The card
uses the original Lanes mark (three lanes of work, Path Blue `#3465a4` on the
Netservant system), never oMLX's own logo or styling.

## Kept

- `preview-transparent.svg` — the gallery source. Transparent background.
- `preview.png` — that SVG rendered at 1024×1024 for the README and npm gallery
  card. `packages/omlx` `pi.image` and the package README both point at
  `https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/omlx/preview.png`.
  The gallery gate requires this file.

## Not kept

The design handoff also included mark, lockup, favicon, and app-icon files, plus
the opaque preview variants (`logo/`, `preview.svg`, `preview-transparent.png`).
Those are for a website, a browser tab, or an app icon. This package ships none
of those surfaces.
