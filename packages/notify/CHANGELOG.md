# Changelog

## [3.0.0](https://github.com/jmcombs/pi-extensions/compare/notify/v2.0.0...notify/v3.0.0) (2026-11-04)


### ⚠ BREAKING CHANGES

* packages no longer accept @earendil-works/pi-coding-agent 1.4.

### Features

* **omlx:** document the package and register it for release ([#382](https://github.com/jmcombs/pi-extensions/issues/382)) ([eb7f0c4](https://github.com/jmcombs/pi-extensions/commit/eb7f0c4e81f467527a05ebe91571ba4d960bbd31))
* require Pi 1.5 ([2b249bd](https://github.com/jmcombs/pi-extensions/commit/2b249bd2888222022693d99be1ae7d0055689e40))

## [2.0.0](https://github.com/jmcombs/pi-extensions/compare/notify/v1.2.0...notify/v2.0.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* **notify:** completion notifications fire on agent_settled, not on each agent_end.

### Bug Fixes

* **notify:** send completion OSC on agent_settled ([#314](https://github.com/jmcombs/pi-extensions/issues/314)) ([f5d092a](https://github.com/jmcombs/pi-extensions/commit/f5d092a04cb6f229283892057c7e705ecace4b39))

## [1.2.0](https://github.com/jmcombs/pi-extensions/compare/notify/v1.1.0...notify/v1.2.0) (2026-09-23)


### Features

* **notify:** notify when agent blocks on ask_user ([#269](https://github.com/jmcombs/pi-extensions/issues/269)) ([ab497af](https://github.com/jmcombs/pi-extensions/commit/ab497afaf21f665fda508b037dfcc88e40324d09)), closes [#219](https://github.com/jmcombs/pi-extensions/issues/219)

## [1.1.0](https://github.com/jmcombs/pi-extensions/compare/notify/v1.0.1...notify/v1.1.0) (2026-05-24)


### Features

* **notify:** support Ghostty OSC 9 with contextual run notifications ([#32](https://github.com/jmcombs/pi-extensions/issues/32)) ([fd3e8d7](https://github.com/jmcombs/pi-extensions/commit/fd3e8d7b8e3f974797dfd3c05f66aaabd2ef6cff))

## [1.0.1](https://github.com/jmcombs/pi-extensions/compare/notify/v1.0.0...notify/v1.0.1) (2026-05-07)


### Bug Fixes

* migrate @mariozechner/* peer deps to @earendil-works/* ([8621f46](https://github.com/jmcombs/pi-extensions/commit/8621f46498add5b871ac206e17ceb78f28657038)), closes [#13](https://github.com/jmcombs/pi-extensions/issues/13)

## 1.0.0 (2026-05-06)


### Features

* **notify:** initial release ([e04ff38](https://github.com/jmcombs/pi-extensions/commit/e04ff381760f3921b10fcaadc936d026b0ee7db9))
