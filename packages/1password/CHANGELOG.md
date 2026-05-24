# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
