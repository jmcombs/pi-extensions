# Netservant — Design System

> *"How may we serve you?"* — **Netservant, LLC**

The design system for **Netservant, LLC**, a software company. Netservant builds Mac and iOS apps — **[macprefs](https://macprefs.app)** (macOS) today, with a CPAP-supplies app for iOS coming next — plus the marketing and brand surfaces around them. This system holds the Netservant identity, a light pastel palette anchored by **Path Blue `#3465a4`**, type, components, and full-surface kits so any product or marketing artifact ships on-brand.

## Identity

- **Wordmark:** **Netservant** set in **Manrope**, one bold weight, one ink color — with the cursive **@e mark** (`Net` + your e + `servant`) as the single Path-Blue accent. It's the 1998 "NeT Servant" @-as-"e" mark, recolored to Path Blue.
- **Tagline:** *"How may we serve you?"* — a separate brand element, **not** part of the logo lockup.
- **Logo assets** (`assets/`): `netservant-e.png` (mark, Path Blue), `netservant-e-white.png` (mark, white), `netservant-icon-512.png` / `-180` / `netservant-favicon-32.png` (app icon + favicons), `netservant-mark-512.png` (square mark).
- **Spec:** `Netservant Logo.html` (lockups, inverted, app icons, 1998→2026 before/after) · Brand card: `guidelines/brand-netservant.card.html`.

---

## CONTENT FUNDAMENTALS — how the brand writes

**Voice:** professional, warm, plainspoken, service-first. Netservant talks to people who just want their Mac/iPhone (or their CPAP supplies) handled well — confident and helpful, never jargon-heavy or hypey.

- **Tone & casing:** Sentence case in prose; tiny `UPPERCASE` mono labels for eyebrows only. App and product names lowercase where they're styled that way (`macprefs`).
- **Person:** Second person, imperative for instructions ("Back up your preferences," "Pick your supplies"). First-person-plural for the company voice ("We read every message").
- **Anchor line:** *"How may we serve you?"* — use as the brand sign-off / hero tagline.
- **Avoid:** dev-theme jargon, coffee puns, and the old "bring the spice / eye-friendly pastels" language (retired). Keep it product- and benefit-focused.
- **Emoji:** not in product UI. Fine, sparingly, in casual marketing only.
- **Vibe:** trustworthy, tidy, quietly modern — like a well-made native app.

---

## VISUAL FOUNDATIONS

**Color.** Light, calm, pastel. A cool neutral ramp (crust `#dce0e8` → mantle → base `#eff1f5`) carries surfaces; the **Path Blue `#3465a4`** accent does the heavy lifting — the @e mark, primary buttons, focus rings, links. A set of soft Catppuccin-Latte-derived accents (mauve, peach, green, teal, red, yellow…) carry status and secondary color. Status mapping: green = success, yellow = warning, red = error, teal = info. *(The palette began life as a Catppuccin Latte light theme; it is now simply the Netservant palette — see `tokens/colors.css`.)*

**Type.** **Manrope** for the wordmark, UI, and body. **JetBrains Mono** for code, numerals, and mono labels. **Instrument Serif** (italic-capable) for the occasional display/tagline moment. For **native apps**, pair these with the platform font (**SF Pro** on macOS/iOS) for in-app chrome — Manrope for marketing, SF for the app itself.

**Spacing & layout.** 4px base scale. Marketing breathes (64–96px section padding, ~1120px max); product UI is denser. See `tokens/spacing.css`.

**Backgrounds.** Flat surface colors — no gradients, photography, or texture as a rule. Depth comes from the crust→base ramp, 1px borders, and soft shadows. Marketing surfaces may use the "paper" treatment (see Paper components).

**Radii.** Restrained for chrome (4–6px), rounder for cards (`--radius-paper` 16px), full pills for buttons/badges.

**Shadows.** Soft, cool, low-opacity (`--shadow-xs`…`--shadow-paper`). Light-theme gentle lift, never heavy.

**Focus / hover / press.** Focus = the Path Blue ring. Hover = darken/lift one step. Press = subtle 1px nudge + slight scale. Motion is calm and quick (120–300ms, ease-out); no bounce, no decorative loops.

**Cards.** Base surface, 1px border or soft shadow, `radius-lg`/`radius-paper`. Border-led, not shadow-heavy.

---

## ICONOGRAPHY

- **Marketing / web UI:** the component cards currently load **[codicons](https://github.com/microsoft/vscode-codicons)** via CDN — fine for web, but see the recommendation to move to a neutral set.
- **Native apps:** use **SF Symbols** (the macOS/iOS system icon set) inside macprefs and the iOS app — it's the right, free, on-platform choice and pairs with SF Pro.
- **Emoji / unicode:** not used as iconography in product UI.
- **Logo:** the @e mark (`assets/netservant-e*.png`, app icon). No other custom icon set ships here yet.

---

## INDEX

**Foundations (root)**
- `styles.css` — entry point (consumers link this).
- `tokens/colors.css` · `typography.css` · `spacing.css` · `fonts.css` — palette, type (Manrope/JetBrains Mono/Instrument Serif), spacing/radius/shadow/motion, webfont imports.

**Components** (`window.<Namespace>.*` — run `check_design_system` for the namespace)
- `components/core/` — **Button**, **Badge**, **Card**
- `components/paper/` — **PaperButton**, **PaperCard**, **FeatureItem**, **TeamCard**, **ContactForm** (Paper Kit 2 PRO shapes in the Netservant palette)
- `components/brand/` — **Swatch** (palette chip)
- `components/code/` — **CodeBlock** + **Tok** (syntax code surface) · **CommandBox** ("Terminal window" CLI box for install/docs pages, e.g. the macprefs site)

**UI kits**
- `ui_kits/paper-landing/` — the Netservant company landing (hero, services, team, contact), built from the Paper components.

**Specimen cards** (`guidelines/*.card.html`) populate the Design System tab — colors, type, spacing, Netservant brand.

**Brand / docs**
- `Netservant Logo.html` — logo specimen. `SKILL.md` — downloadable Agent Skill. `uploads/NSLogoBig.gif`, `NSLogoSm.gif` — original 1998 logos (reference).

---

## CAVEATS / recommendations
- **Dark mode is in.** Set `data-theme="dark"` on `<html>` (or any ancestor) — the token ramp flips to Catppuccin Mocha with a lightened Path-Blue accent (`tokens/colors.css`). Components built on the semantic + `--latte-*` tokens flip automatically.
- **Next up: product surfaces.** With the dev-theme artifacts cleared, the priority is the **macprefs marketing/docs site** (CLI boxes via `CommandBox`, install/quick-start pages) and later the **CPAP-app (iOS)** kit — Netservant is shipping software.
- **Platform fonts & icons.** Use **SF Pro + SF Symbols** in-app; keep **Manrope + a neutral web icon set** for marketing.
- **Paper Kit blend.** `components/paper/*` and `ui_kits/paper-landing/` adapt the layout/shape language of **Paper Kit 2 PRO** (Creative Tim) in the Netservant palette — a brand re-creation, not a copy of their stylesheet. Marketing imagery uses pastel-gradient placeholders; swap in real assets.
- **Fonts** load from Google Fonts (Manrope, JetBrains Mono, Instrument Serif).
