# opencode-mcp-toggle

> Seamlessly toggle OpenCode MCP servers on the fly and save context tokens directly from [Paseo](https://paseo.sh).

[![Paseo](https://img.shields.io/badge/Paseo-Plugin-blue)](https://paseo.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## The Problem: MCP Token Bloating

Every active Model Context Protocol (MCP) server injects its full tool schema (names, descriptions, parameters, validation JSON) into **every single LLM request's system prompt**. 

Large MCP servers (like Jira, Playwright, Database inspectors, or Figma) easily consume **3,000 to 10,000+ tokens per turn**. When these tools aren't actively needed for the current task, they waste money, degrade prompt attention, and shrink your useful context window.

While OpenCode's native terminal UI provides `/mcps` to enable/disable servers dynamically, **Paseo currently has no native UI to manage or toggle third-party MCP servers**.

**`opencode-mcp-toggle` bridges this gap.**

---

## Features

- ⚡ **1-Click Dynamic Toggling**: Enable or disable any MCP server in real time via OpenCode's internal server API. Disabling a server instantly purges its tool schemas from subsequent prompt requests.
- 💾 **Auto-Save as Default (`opencode.json`)**:
  - Keep **"Save as default"** checked (default) to persist the toggle state across restarts.
  - Uncheck it to toggle servers temporarily for the current session only.
- 📱 **Mobile & Desktop First**:
  - **Desktop**: Compact, anchored inspector popover directly above the composer.
  - **Mobile**: Native adaptive bottom sheet with gesture support.
- 🔒 **Security Hardened**:
  - Resolves target working directories server-side using trusted daemon agent state (prevents path traversal / CWE-22).
  - No secrets or credentials ever cross the client RPC boundary.
- 🚀 **Zero Configuration**:
  - Automatically discovers running `opencode serve` daemon instances and their ports.
  - Automatically activates in the composer bar only when interacting with OpenCode agents.

---

## Installation

Ensure plugins are enabled in your Paseo daemon (`pluginsEnabled: true` in `~/.paseo/config.json`).

### From Git (Recommended)

```bash
paseo plugin add Davnn1/opencode-mcp-toggle
```

### From Local Checkout

```bash
git clone https://github.com/Davnn1/opencode-mcp-toggle.git
cd ~
paseo plugin install ./opencode-mcp-toggle
```

> **Note**: If installing from a local path on Linux AppImage, always provide a relative path (e.g. `./folder`) from your working directory.

To verify the installation:

```bash
paseo plugin ls
```

---

## Usage

1. Open any **OpenCode agent session** in Paseo (desktop or mobile).
2. Look at the composer bar at the bottom: an **`[ • MCP ]`** pill will appear.
3. Tap the pill to open the server manager:
   - **Flip the switch**: Instantly disconnects or reconnects the MCP server for the running session.
   - **Save as default**: When checked, your choices are automatically saved to your workspace or global `opencode.json(c)`.
   - If a server is toggled only for the current session without saving, it will be clearly marked with a `session only` badge.

---

## How It Works

1. **Daemon Service**: Scans active `opencode serve` instances and connects to their local HTTP management endpoints (`GET /mcp`, `POST /mcp/{name}/connect|disconnect`).
2. **Persistence**: Parses and applies surgical edits to `opencode.json` / `opencode.jsonc` using `jsonc-parser`, preserving comments and formatting.
3. **Client UI**: Built using React Native and Paseo's `@getpaseo/plugin` design primitives, automatically adjusting between desktop popovers and mobile bottom sheets.

---

## License

[MIT](LICENSE) © 2026 Davnn
