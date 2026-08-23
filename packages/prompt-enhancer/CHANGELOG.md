# Changelog

## [3.0.1](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v3.0.0...prompt-enhancer/v3.0.1) (2026-08-23)


### Bug Fixes

* **prompt-enhancer:** stop returning an announcement instead of a rewrite ([#220](https://github.com/jmcombs/pi-extensions/issues/220)) ([e56c3d1](https://github.com/jmcombs/pi-extensions/commit/e56c3d1a99a47955df5037923523b1250acf800e))

## [3.0.0](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v2.0.2...prompt-enhancer/v3.0.0) (2026-08-18)


### ⚠ BREAKING CHANGES

* **prompt-enhancer:** Commands are now /prompt_enhance, /prompt_enhance_model, /prompt_enhance_revert, and /prompt_enhance_auto. The /enhance* aliases are removed. Enhance is Ctrl+Shift+E; Ctrl+Shift+P is no longer registered.

### Features

* **prompt-enhancer:** 3.0 overhaul ([#215](https://github.com/jmcombs/pi-extensions/issues/215)) ([83c923a](https://github.com/jmcombs/pi-extensions/commit/83c923ab0469349b953605e8f0dd2a017b124628))

## [2.0.2](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v2.0.1...prompt-enhancer/v2.0.2) (2026-07-19)


### Bug Fixes

* **prompt-enhancer:** align pi-ai/compat import for pi 0.80.8 typecheck ([4d96b0d](https://github.com/jmcombs/pi-extensions/commit/4d96b0dcc3453a6daa18af98074f7176e6fc0570))

## [2.0.1](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v2.0.0...prompt-enhancer/v2.0.1) (2026-05-07)


### Bug Fixes

* migrate @mariozechner/* peer deps to @earendil-works/* ([8621f46](https://github.com/jmcombs/pi-extensions/commit/8621f46498add5b871ac206e17ceb78f28657038)), closes [#13](https://github.com/jmcombs/pi-extensions/issues/13)

## [2.0.0](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v1.1.0...prompt-enhancer/v2.0.0) (2026-05-04)


### ⚠ BREAKING CHANGES

* **prompt-enhancer:** Consumers running Node 20 must upgrade to Node 22 or later before installing this version.

### Features

* **prompt-enhancer:** require Node &gt;=22.0.0 ([e255a02](https://github.com/jmcombs/pi-extensions/commit/e255a02251a70ebaa71cc79160198627415444bb))

## [1.1.0](https://github.com/jmcombs/pi-extensions/compare/prompt-enhancer/v1.0.0...prompt-enhancer/v1.1.0) (2026-05-04)


### Features

* **prompt-enhancer:** add gallery preview screenshot and video ([d2c380e](https://github.com/jmcombs/pi-extensions/commit/d2c380eabdef47d76c7a68eb2fd5b0d44efbd4b6))

## 1.0.0 (2026-05-04)


### Features

* **prompt-enhancer:** add persistent widget, transient status, picker fix ([0fd7042](https://github.com/jmcombs/pi-extensions/commit/0fd70424497833dcfc9a008881e9be23619f1169))
* **prompt-enhancer:** implement enhance command, ctrl+shift+e shortcut, and model picker ([11995de](https://github.com/jmcombs/pi-extensions/commit/11995de7ec38bbdf99e64e3bfd3562d48922f8fd))
* **prompt-enhancer:** rebind shortcuts, add revert, expose footer hints ([40347cb](https://github.com/jmcombs/pi-extensions/commit/40347cbf442c65f2b68dad6093acdb806272ae8a))


### Bug Fixes

* **prompt-enhancer:** size /enhance-model picker to fit short terminals ([bc5284b](https://github.com/jmcombs/pi-extensions/commit/bc5284bdb2928517fec20106d30bfe412d689306))


### Reverts

* **prompt-enhancer:** drop overlay wrapper around /enhance-model picker ([6843027](https://github.com/jmcombs/pi-extensions/commit/68430276b4d9be17ee3f6240f617cf10d5ca8d13))
