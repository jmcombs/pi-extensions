# Changelog

## [2.0.0](https://github.com/jmcombs/pi-extensions/compare/context7/v1.0.0...context7/v2.0.0) (2026-07-19)


### ⚠ BREAKING CHANGES

* **context7:** pi 0.80.8 removed the AuthStorage API this extension used to store and read its API key. Credentials now resolve through the @jmcombs/pi-1password credential API, a hard dependency that installs automatically. Onboarding is availability-branched (1Password vault picker when `op` is configured, masked manual entry otherwise). Existing Context7 keys in ~/.pi/agent/auth.json keep resolving unchanged — no migration action is required.

### Documentation

* **context7:** note AuthStorage removal and 1Password credential-API migration ([df27901](https://github.com/jmcombs/pi-extensions/commit/df27901c61c7dcba7d4c55becef2498b5cd2c8e3))

## [1.0.0](https://github.com/jmcombs/pi-extensions/compare/context7/v0.2.0...context7/v1.0.0) (2026-05-25)


### Features

* **context7:** initial implementation of @jmcombs/pi-context7 ([#39](https://github.com/jmcombs/pi-extensions/issues/39)) ([e5c3988](https://github.com/jmcombs/pi-extensions/commit/e5c39882bf5bbf42aa0e7ff3b705790e53db0648))

## [0.2.0](https://github.com/jmcombs/pi-extensions/compare/context7/v0.1.1...context7/v0.2.0) (2026-05-25)


### Features

* **context7:** initial implementation of @jmcombs/pi-context7 ([#39](https://github.com/jmcombs/pi-extensions/issues/39)) ([e5c3988](https://github.com/jmcombs/pi-extensions/commit/e5c39882bf5bbf42aa0e7ff3b705790e53db0648))
