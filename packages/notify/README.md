# @jmcombs/pi-notify

A [Pi coding agent](https://pi.dev) extension that sends a notification via your
terminal emulator's native system (OSC 777/9/99) when Pi finishes a turn and is
waiting for your input — so you can switch away while Pi works and get tapped on
the shoulder the moment it's done. Works in Ghostty, iTerm2, WezTerm, Kitty, etc.
with zero OS binaries or dependencies.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-notify

# For a single session, without installing
pi -e npm:@jmcombs/pi-notify
```

## What It Adds

- **Event hook**: `agent_end` — automatically sends a terminal notification (via
  OSC) each time the agent finishes a turn and is waiting for input.
- **Command**: `/notify [message]` — sends a one-shot test notification. Useful for
  verifying the extension is working after install. Defaults to
  `"Waiting for your input"` when called with no argument.

No tools are registered. The LLM does not call this extension directly.

## Terminal Support

Notifications are delivered using the terminal emulator's built-in OSC notification
protocols (no OS daemons, no extra packages, no binaries). Supported terminals:

| Terminal Emulator                  | Protocol | Notes                                                                                                                |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| Ghostty (recommended)              | OSC 9    | Auto-detected via `TERM_PROGRAM`. Requires macOS notification permission + `desktop-notifications = true` (default). |
| iTerm2                             | OSC 9    | Auto-detected via `TERM_PROGRAM` / `ITERM_SESSION_ID`.                                                               |
| WezTerm                            | OSC 777  | Full support.                                                                                                        |
| Kitty                              | OSC 99   | Auto-detected via `KITTY_WINDOW_ID`.                                                                                 |
| rxvt-unicode                       | OSC 777  | Full support.                                                                                                        |
| Windows Terminal (via WSL)         | OSC 777  | When `WT_SESSION` is present.                                                                                        |
| tmux (inside a supported terminal) | wrapped  | DCS passthrough applied automatically when `TMUX` env var is set.                                                    |

**Unsupported** (examples: Apple Terminal, Alacritty, base Windows console):
the extension shows a message in the Pi TUI and recommends filing an issue at
https://github.com/jmcombs/pi-extensions/issues.

No permissions dialogs or extra setup are required for most terminals. Desktop
notification _appearance_ (banners, sounds, persistence) is controlled entirely by
your terminal emulator + OS notification center settings. Configure those in the
terminal's preferences and/or macOS System Settings → Notifications. This
extension emits no audio or OS notifications itself.

### Ghostty on macOS

Ghostty enables OSC notifications by default (`desktop-notifications = true`).
For the desktop notification to appear as a banner:

1. **Permissions**: System Settings → Notifications → Ghostty → Allow
   notifications. Set Alert Style to "Banners" (temporary) or "Alerts"
   (persistent).
2. **(Optional) Config**: Add to your Ghostty config if you had disabled it:
   ```
   desktop-notifications = true
   ```
   (Restart Ghostty or use `ghostty +reload-config` after changes.)
3. **Testing**: Run `/notify Test Notification`. Banners typically only appear
   when the Ghostty window is _unfocused_ (background). When focused, check
   Notification Center; Ghostty may show a brief in-window indicator.

If no notification appears despite the above, the sequence was still written
(successfully detected by the `/notify` command). Check Ghostty logs or file an
issue.

## Requirements

- Pi `>= 0.72.0`
- Node `>= 22.0.0`
- No API keys or additional configuration required

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real Pi session
pi -e ./packages/notify
```

The smoke test in `index.test.ts` verifies registration shape only — no OSC
sequences or external calls are made during testing. Real end-to-end behaviour
(terminal notifications) is exercised via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
