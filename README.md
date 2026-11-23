# pi-local-cli

[![tests](https://github.com/ErkundenSie/pi-local-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ErkundenSie/pi-local-cli/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi-package-7c3aed.svg)](https://pi.dev/packages)

Use the AI coding CLIs you already have installed and signed in to as models inside [Pi](https://github.com/earendil-works/pi).

Pi starts each CLI as a child process and speaks its native protocol over stdio — Codex App Server for Codex, ACP for the rest. The CLI keeps its own login and talks to its own vendor; this extension never reads credentials, never proxies an account, and needs no Magpie or Bun runtime. **Running a CLI locally is not the same as running a model offline.**

[中文说明](./README.zh-CN.md)

## Features

- **Real model picker entries.** `/model` lists each CLI as `local-cli/<agent>-<model>`, with native model IDs discovered from the CLI itself.
- **Native streaming.** Assistant text, reasoning text and token usage stream through as the CLI produces them.
- **Pi tools stay in Pi.** Tools declared by the Pi session are exposed to the CLI as a local MCP server. The CLI calls them natively; Pi executes each call once with its own permissions, hooks and result rendering.
- **Session reuse, not repeated history.** A live native session is reused while the model, thinking level, tool set and history prefix all match. Anything else replays the history in a fresh session.
- **Antigravity resume across restarts.** A completed `agy` session can be picked up after Pi or the CLI restarts, sending only the new messages.
- **Honest accounting.** Context occupancy, last-inference usage and whole-turn totals are reported separately instead of being conflated.
- **Failures that do not duplicate work.** A tool result that can no longer be delivered is reported, never replayed.

## Supported CLIs

| Agent | Launched as | Preparation |
|---|---|---|
| OpenAI Codex | `codex app-server --listen stdio://` | Install Codex and sign in with `codex login` |
| Claude Code | `claude-agent-acp` wrapping your `claude` | Install native Claude Code, then `npm install -g @agentclientprotocol/claude-agent-acp` |
| Google Antigravity CLI | `agy acp` | Install Antigravity CLI and sign in with `agy` |
| Grok Build | `grok agent --no-leader stdio` | Install Grok Build and run `grok login` |

A detected executable is not proof of a working sign-in; run `/local-cli doctor` for the current state.

## Requirements

- Node.js 22 or newer.
- A Pi build that registers native providers with an injectable `fetch` (tested with Pi 1.5.2).
- At least one supported CLI, signed in from your own terminal.

## Install

```bash
pi install git:github.com/ErkundenSie/pi-local-cli
```

From a local checkout:

```bash
git clone https://github.com/ErkundenSie/pi-local-cli
cd pi-local-cli
npm ci
pi install .
```

Try it for one session without installing:

```bash
pi -e /absolute/path/to/pi-local-cli/index.mjs
```

Then run `/local-cli` to see what was detected, and `/model` to pick a `local-cli/*` entry.

### In Pi Web

Restart the Pi Web server, open **Settings → Models → Local CLI** (no API key is needed), click **Refresh model catalog**, enable the models you want and **Save**. New models are not added to an existing `enabledModels` allow-list automatically.

`Antigravity (agy)` and `xAI (Grok/X subscription)` in that list are separate providers, not this extension's `Local CLI`.

## Model names

```
local-cli/<agent>-<native model id>   e.g. local-cli/codex-gpt-6.2-sol
local-cli/<agent>-default             let the CLI pick its own model
```

Model discovery runs through the same protocol Pi uses for chat, so no extra login or API key is involved. When a CLI reports no catalog, only its `-default` entry appears.

## Commands

| Command | Purpose |
|---|---|
| `/local-cli` | Detected executables |
| `/local-cli status` | What the current session's last turn is doing |
| `/local-cli doctor` | Executables, catalog source, last success and last failure |
| `/local-cli doctor probe` | Query catalogs now (no inference, does not change enabled models) |
| `/local-cli usage` | Context occupancy, last-inference usage and turn total |

## Configuration

Executables are resolved from `PATH`, common install locations, and the Codex Desktop bundle on Windows. To pin a path, copy `.local-agents.example.json` to `.local-agents.json` next to `index.mjs`:

```json
{
  "executables": {
    "antigravity": "C:/Users/you/AppData/Local/agy/bin/agy.exe"
  }
}
```

Keep only the entries you need. Windows prefers `.exe`, also accepts a standard npm `.cmd` shim (resolved to its JavaScript entry point, never through `cmd.exe`), and supports prefix arguments:

```json
{ "path": "D:/Tools/node.exe", "args": ["D:/Tools/cli-entry.mjs"] }
```

Claude Code itself must be a native executable; only the ACP adapter may be an npm shim.

| Environment variable | Effect |
|---|---|
| `PI_LOCAL_CLI_CONFIG` | Absolute path to an alternative executable config |
| `PI_LOCAL_CLI_AGY_RESUME=0` | Disable on-disk Antigravity checkpoints; keep in-process reuse only |

The executable config belongs to the extension user. It is never read from the project being worked on: only configure binaries and scripts you trust, because they run as you.

## How it works

```
Pi  ──Chat Completions──▶  in-process adapter  ──stdio JSON-RPC──▶  codex app-server / agy acp / grok agent / claude-agent-acp
 ▲                                                                                    │
 └──────────────── Pi tool bridge (loopback MCP, random port + token) ◀───────────────┘
```

- Chat Completions is adapted in-process. There is no HTTP endpoint, and nothing listens for chat traffic.
- The only listener is a loopback MCP bridge started on demand, bound to `127.0.0.1` on a random port with a per-session token. The CLI spawns the stdio shim that talks to it.
- When the CLI calls a Pi tool, the native turn parks. Pi runs the tool in its own loop, then the result is handed back to the same parked call.
- Each CLI runs in its own temporary directory with its built-in tools restricted; approval requests the extension cannot answer are declined.

### Timeouts

Inference is capped at 5 minutes per native turn, measured only while the CLI is generating. Waiting for a Pi tool pauses that budget and has its own 10-minute limit, still bounded by any shorter CLI limit. Pi Web shows when a turn is waiting or has lost its bridge connection.

If a result can no longer be delivered — bridge lost, wait expired, turn cancelled — the request fails instead of silently replaying. Check the tool output already in the conversation before sending a new message.

### Antigravity checkpoints

After a completed `agy` turn, the native process is kept for reuse and a checkpoint is written under `<agentDir>/local-cli/agy-checkpoints` (usually `~/.pi/agent/local-cli/agy-checkpoints`, mode 0600). A checkpoint contains only the native session ID, model, timestamps and history/tool fingerprints — never messages, tool output, images or tokens.

A restart resumes that native session only when the previous turn completed, the owning process is gone or has released its lease, and the model, settings, tool set and history prefix all match. The old checkpoint is invalidated before the native history is advanced, so a half-finished turn cannot be restored. Checkpoints expire after 6 hours. Branches, compaction, a CLI upgrade or a refused resume fall back to a fresh session with the history Pi already stores. Parked tool calls are never resumed.

Codex keeps in-process threads only: an `ephemeral: true` thread has no rollout on disk, so `thread/resume` after an App Server restart is impossible by design (verified on App Server 0.171.0). Grok and Claude Code do not use on-disk checkpoints yet.

## Notes on behavior

- Codex context windows come from Codex's own `models_cache.json` (`context_window`, not the higher optional `max_context_window`). Without a matching entry the extension falls back to 128,000, and output limits are estimates; the CLI and its vendor decide the real limits.
- Images are forwarded only when the CLI advertises support, and the whole request — history plus inline base64 — is capped at 2 MiB.
- Codex runs read-only, approval-free and ephemeral under this extension. Other CLIs keep their own configuration; native tools outside the caller's tool set are denied.
- **This is not a general-purpose OS sandbox.** A model can still ask for tools the Pi session has enabled, and Pi decides how they run.
- The MCP bridge is intended for a single-user developer machine: another process running as the same user could read the per-session token from the CLI's own configuration.
- Subscription quota and billing remain the CLI vendor's business. If Grok Build returns `HTTP 402`, check the Grok Build account balance; it is unrelated to model discovery, Pi API keys or session resume.
- Pi Web's header does not separate cumulative turn usage from context occupancy, so treat `/local-cli usage` as the more precise view. Usage is kept in memory for the current session only.

## Troubleshooting

| Symptom | Check |
|---|---|
| A CLI is missing from `/model` | `/local-cli doctor`, then `doctor probe`; pin the path in `.local-agents.json` if needed |
| Only `-default` models appear | Refresh the catalog in Pi Web or run `/local-cli doctor probe`; the CLI may be signed out |
| Antigravity model has no thinking levels | Discovery fell back to `agy models`, which fixes the model set but may not describe thinking levels |
| Turn hangs while a tool runs | `/local-cli status`; the wait is bounded, and a lost bridge is reported rather than retried |
| Resume never happens (Antigravity) | Turn must have completed, the history prefix must match, and the checkpoint must be under 6 hours old |

## Development

```bash
npm ci
npm test          # simulated Codex App Server and ACP; no account quota
npm run doctor    # list detected executables
```

The suite covers streaming, usage, tool round-trips, cancellation, lost bridges and processes, checkpoint leases, resume matching and model discovery. Scripts that touch a real CLI or a real Pi Web spend real quota:

```bash
node scripts/smoke-agy-pi-web.mjs <pi-web-install-path>          # simulated ACP
node scripts/smoke-agy-pi-web.mjs <pi-web-install-path> --live   # real agy
node scripts/benchmark-agy.mjs 2 [--cold-resume]                 # reply latency
node scripts/probe-codex-resume.mjs [codex-model-id]             # ephemeral thread resume
```

Layout:

| Path | Purpose |
|---|---|
| `index.mjs` | Pi entry point: provider registration, commands, status reporting |
| `lib/provider.mjs` | Turn lifecycle: model routing, parking, reuse, checkpoints |
| `lib/model-discovery.mjs`, `lib/catalog.mjs` | Executable detection and catalog discovery |
| `lib/history.mjs` | History/tool fingerprints, prefix matching, continuation prompts |
| `lib/session.mjs`, `lib/session/*` | Codex App Server and ACP adapters over shared transport |
| `lib/tool-bridge.mjs`, `lib/mcp-stdio.mjs`, `lib/bridge-server.mjs` | Loopback MCP tool bridge |
| `lib/checkpoints.mjs` | Antigravity checkpoint storage and leases |

## Credits

Protocol handling and the MCP tool-bridge design are ported from [ErkundenSie/magpie-local-agents](https://github.com/ErkundenSie/magpie-local-agents) (MIT). The Magpie page plugin, gateway and subscription-quota UI are not included.

## License

[MIT](./LICENSE)
