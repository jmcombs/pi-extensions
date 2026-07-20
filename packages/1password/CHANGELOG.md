# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0](https://github.com/jmcombs/pi-extensions/compare/1password/v2.0.0...1password/v2.1.0) (2026-07-20)


### Features

* **1password:** update curated shell plugins list from upstream source ([#175](https://github.com/jmcombs/pi-extensions/issues/175)) ([5df0380](https://github.com/jmcombs/pi-extensions/commit/5df03806024cf45fb626c52b770dcd4fc542e728))

## [2.0.0](https://github.com/jmcombs/pi-extensions/compare/1password/v1.0.2...1password/v2.0.0) (2026-07-19)


### ⚠ BREAKING CHANGES

* **1password:** pi 0.80.8 removed the AuthStorage API this extension was built on. Credentials now resolve through a stateless credential API this package exports for other extensions to consume, and onboarding writes `!op read '…'` entries to ~/.pi/agent/auth.json. Onboarding is availability-branched (1Password vault picker when `op` is configured, masked manual entry otherwise). The `1p_run` tool has been retired; transparent credential injection into bare CLIs is unchanged. Existing `!op read` entries in auth.json keep resolving unchanged — no migration action is required.

### Features

* **1password:** stateless credential API + warm-on-load + API reference (Phase 2) ([#141](https://github.com/jmcombs/pi-extensions/issues/141)) ([5883f29](https://github.com/jmcombs/pi-extensions/commit/5883f29ccf750078556b543ddce73f04ec302a96))


### Documentation

* **1password:** note AuthStorage removal, credential API, and 1p_run retirement ([285de01](https://github.com/jmcombs/pi-extensions/commit/285de0160e175b189f8a92fd7f5b464714245b5c))

## [1.0.2](https://github.com/jmcombs/pi-extensions/compare/1password/v1.0.1...1password/v1.0.2) (2026-06-29)


### Bug Fixes

* **blue-psl-10k:** rewrite broken test + clear residual audit vulnerabilities ([#83](https://github.com/jmcombs/pi-extensions/issues/83)) ([36adc46](https://github.com/jmcombs/pi-extensions/commit/36adc4630e7563fe9029181bff7ed1e7c25ffd8b))

## [1.0.1](https://github.com/jmcombs/pi-extensions/compare/1password/v1.0.0...1password/v1.0.1) (2026-05-25)


### Bug Fixes

* **1password:** eliminate detect-object-injection eslint disables using Map ([#36](https://github.com/jmcombs/pi-extensions/issues/36)) ([7d6faad](https://github.com/jmcombs/pi-extensions/commit/7d6faad454bd1f72e98812ec53299b46444506d8))

## 1.0.0 (2026-05-24)


### Features

* **1password:** add rich bordered TUI for /1password_onboard, improve README onboarding, register with Release Please for 1.0.0 bootstrap ([#34](https://github.com/jmcombs/pi-extensions/issues/34)) ([bbfcd8f](https://github.com/jmcombs/pi-extensions/commit/bbfcd8fe604ba1ef681f74cec9654866d018f6ae))

## [Unreleased]

## [1.0.0] - 2026-05-24

### Added
- Initial release of @jmcombs/pi-1password
- `/1password_onboard` guided setup command with rich bordered TUI
- Transparent 1Password credential injection via auth.json + `!op read`
- `1p_run` tool for running commands with 1Password injection
- `/1password_diagnose` command and `1p_diagnose` tool
