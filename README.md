# Pi Glance

A Pi extension that reduces transcript noise by rendering tool calls and results in a compact UI.

## Features

- Collapses tool details by default for a cleaner conversation view.
- Shows one-line tool summaries.
- Uses configurable colored tool call backgrounds:
  - `read`: green, with gray text and total lines read after completion.
  - `edit`: yellow/brown, showing the filename and edit count.
  - `write`: orange, showing the filename.
  - `bash`: blue/gray compact command line with exit status.
  - `grep`/`find`/`ls`: muted purple or gray.
- Stores hidden bash/read output for later viewing.
- Provides a right-side output viewer for captured bash/read output.
- Shows read-file output with line numbers and lightweight syntax highlighting.
- Supports configurable shortcuts and display presets.

## Commands

```text
/glance help
/glance status
/glance on
/glance off
/glance preset silent|minimal|balanced|debug
/glance output
/glance reload-config
```

`/glance help` opens an in-app help overlay that explains what Pi Glance does, lists commands and shortcuts, and shows the current enabled/preset/output count state.

## Shortcuts

Default shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+C` | Toggle Pi Glance on/off |
| `Ctrl+Alt+B` | Toggle tool details expanded/collapsed |
| `Ctrl+Shift+B` | Open output viewer |
| `Ctrl+Shift+Left` | Previous output in viewer |
| `Ctrl+Shift+Right` | Next output in viewer |
| `Ctrl+Shift+Down` | Scroll viewer down |
| `Ctrl+Shift+Up` | Scroll viewer up |
| `Esc` | Close overlay |

## Configuration

Configuration is loaded from:

1. Global: `~/.pi/agent/pi-glance.json`
2. Project: `.pi/pi-glance.json`

Project config overrides global config.

Example:

```json
{
  "enabled": true,
  "preset": "minimal",
  "tools": {
    "displayMode": "one-line",
    "collapseByDefault": true,
    "argsMaxChars": 120
  },
  "colors": {
    "readBg": 22,
    "readFg": 245,
    "editBg": 94,
    "writeBg": 130,
    "bashBg": 17
  },
  "bash": {
    "outputVisible": false,
    "storeHiddenOutput": true,
    "viewer": {
      "enabled": true,
      "maxStoredCommands": 20,
      "pageSize": 20
    }
  },
  "shortcuts": {
    "toggleToolDetails": "ctrl+alt+b"
  }
}
```

## Installation

Install from GitHub:

```bash
pi install git:github.com/gjongerh/pi-glance
```

For a one-off trial without writing settings:

```bash
pi -e git:github.com/gjongerh/pi-glance
```

## Development

From the repository root, run:

```bash
make test
```

This runs TypeScript type checking for `pi-glance/index.ts`.
