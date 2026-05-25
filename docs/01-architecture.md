# 01 — Architecture

## Three-layer model

Wazir has three logical layers with explicit contracts between them:

```
┌──────────────────────────────────────────────────┐
│  INTERFACE ADAPTERS                              │
│    Telegram  •  Web  •  Voice+AR  •  CLI         │
│    - render notifications to the user            │
│    - capture user decisions                      │
└────────────────────┬─────────────────────────────┘
                     │ Hub protocol (JSON over HTTP/WS)
┌────────────────────▼─────────────────────────────┐
│  HUB                                             │
│    - registers workers, sessions, agents         │
│    - routes approval requests to adapters        │
│    - persists approval/decision history          │
│    - source-agnostic                             │
└────────────────────┬─────────────────────────────┘
                     │ Worker protocol (JSON over HTTP/WS)
┌────────────────────▼─────────────────────────────┐
│  WORKERS (one per machine)                       │
│    - manage tmux sessions / PTYs                 │
│    - intercept agent webhooks (Claude Code, etc.)│
│    - execute approved commands                   │
│    - stream output                               │
│                                                  │
│  agent processes: Claude Code, Codex, Aider, ... │
└──────────────────────────────────────────────────┘
```

**Each layer has zero knowledge of layers two steps away.** Interface adapters don't know about tmux. Workers don't know about Telegram. The hub mediates.

## Why this shape

Three properties fall out for free:

1. **Pluggable interfaces** — swap Telegram for AR glasses without touching workers or agents.
2. **Multi-machine ready** — workers register with the hub over the network; the hub can later move to a Pi or VPS without changing worker code.
3. **Source-agnostic** — any agent that can call a webhook plugs into a worker. Claude Code today, anything tomorrow.

## Phase 1 deployment (single machine, single user)

```
                              MacBook
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Hub  (Express, :7842) ◄────────► SQLite (~/.wazir/db)     │
│            ▲                                                │
│            │ Hub protocol                                   │
│            ▼                                                │
│   Worker  (Express, :7843)                                  │
│            ▲                                                │
│            │ HTTP hook                                      │
│            ▼                                                │
│   Claude Code  (PreToolUse hook → http://localhost:7843)    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │ Telegram Bot API (HTTPS, outbound)
                          ▼
                       Telegram
                          ▲
                          │
                       Phone
```

Hub and worker are **separate processes** on the same machine in Phase 1, talking over localhost. The protocol is the same one used in Phase 5 when the hub moves to a Pi — the only difference is the hostname.

## Contracts

These are the protocol surfaces. They are deliberately small.

### Worker → Hub: register

Worker introduces itself at startup, then heartbeats every 30s.

```http
POST /v1/workers
{
  "worker_id": "macbook-fay",
  "hostname": "Fay-MBP.local",
  "platform": "darwin",
  "version": "0.1.0",
  "capabilities": ["claude-code-hook", "tmux", "screenshot"]
}
→ 200 OK { "registered_at": "..." }
```

### Worker → Hub: approval request

Triggered when an agent's webhook (e.g. Claude Code `PreToolUse`) hits the worker and the command is classified as risky.

```http
POST /v1/approvals
{
  "request_id": "uuid",
  "source": "claude-code",
  "worker_id": "macbook-fay",
  "session_id": "claude-session-uuid",
  "command": "git push origin main",
  "context": {
    "cwd": "/Users/fay/Projects/...",
    "tool_name": "Bash",
    "risk_class": "git_push"
  },
  "callback_url": "http://localhost:7843/v1/decisions/{request_id}",
  "timeout_seconds": 540
}
→ 202 Accepted { "approval_id": "..." }
```

### Hub → Interface Adapter: notify

The hub fans this out to every registered adapter (Phase 1: just Telegram).

```json
{
  "type": "approval_request",
  "approval_id": "...",
  "title": "Approve git push?",
  "body": "git push origin main\n@ macbook-fay : ~/Projects/...",
  "voice_prompt": "Approve a git push to main from the YourCampus repo?",
  "actions": [
    { "id": "approve", "label": "Approve", "voice_phrase": "approve",  "style": "primary" },
    { "id": "reject",  "label": "Reject",  "voice_phrase": "reject",   "style": "danger" },
    { "id": "modify",  "label": "Modify",  "voice_phrase": "modify",   "style": "secondary" }
  ]
}
```

`voice_prompt` and `voice_phrase` are **set but unused in Phase 1**. They exist so the Phase 7 AR voice adapter can use them without a protocol change.

### Interface Adapter → Hub: decision

```http
POST /v1/approvals/{approval_id}/decide
{
  "action": "approve" | "reject" | "modify",
  "modified_command": "git push origin main --dry-run",
  "actor": "telegram:chat_id=123456789"
}
```

### Hub → Worker: decision callback

Hub POSTs to the `callback_url` from the original request:

```http
POST {callback_url}
{
  "request_id": "...",
  "decision": "approve" | "reject" | "modify",
  "command": "..."
}
```

The worker then returns the appropriate response shape to the agent (e.g. for Claude Code, the JSON `permissionDecision` body).

## Interface Adapter pattern

A future-proof contract:

```ts
interface InterfaceAdapter {
  name: string;                                     // "telegram" | "web" | "voice-ar"

  start(hub: HubClient): Promise<void>;

  // Hub → adapter
  sendNotification(n: HubNotification): Promise<void>;

  // Adapter → hub (registered as callback)
  onUserDecision(handler: (d: UserDecision) => Promise<void>): void;

  stop(): Promise<void>;
}
```

Implementations:

| Adapter | Phase | What it does |
|---|---|---|
| `TelegramAdapter` | 1 | Telegraf bot. Inline buttons. Allowlisted chat IDs. |
| `CLIAdapter` | 1 | For local testing without Telegram. Renders notifications to stdout, reads decisions from stdin. |
| `WebAdapter` | 4 | WebSocket to a React dashboard. Same protocol. |
| `VoiceARAdapter` | 7 | TTS the `voice_prompt`. STT listens for `voice_phrase` matches. Spatial UI for output. |

**The hub never imports any adapter.** Adapters are registered at startup; the hub talks to them through the interface.

## Voice + AR considerations (Phase 7) — locked in now

Voice and AR introduce requirements that the Phase 1 protocol must not preclude. Decisions baked into v1 contracts:

- **TTS-friendly text.** Notifications carry both `label` (display text) and `voice_prompt` (spoken form). Actions carry both `label` and `voice_phrase`. Phase 1 sets both to the same value; later phases differentiate.
- **Conversation continuity.** AR is closer to streaming dialogue than ping-pong. We keep the hub protocol request/response — the conversational/buffering layer lives in the adapter, which can group multiple approvals into one spoken thread.
- **Spatial UI**: the AR adapter may render tmux panes or screenshots in spatial space. That's the adapter's business; the hub provides streams, not layouts.
- **Wake words and multi-agent addressing.** `@backend-agent` syntax is parsed by the adapter, not the hub. The hub receives a structured `{target_session, prompt}` payload.

We are not building any of this now. We are making sure the Phase 1 protocol does not become the bottleneck.

## Cross-platform strategy

| OS | Status | Notes |
|---|---|---|
| macOS | First-class, primary dev target | Native tmux, `screencapture`, `osascript` |
| Linux | First-class | tmux, `grim`/`scrot`, `notify-send` |
| Windows | Via WSL2 | Worker runs in WSL; hub can be Windows-native if needed |
| Raspberry Pi (Linux ARM) | Hub-only target | Workers usually live on dev machines |

OS-specific code is isolated:

```
worker/src/platform/
├── screenshot.mac.ts     // screencapture -i ...
├── screenshot.linux.ts   // grim / scrot
├── notify.mac.ts         // osascript -e ...
├── notify.linux.ts       // notify-send
└── index.ts              // selects at runtime via process.platform
```

Core code imports `./platform` only. Native Windows support = adding two files. We do not do it in Phase 1 (WSL is fine).

## What the AR end-state changes — and what it doesn't

This is the test of the architecture. If going from Telegram to AR forces hub changes, we drew the boundaries wrong.

| Concern | Phase 1 (Telegram) | Phase 7 (AR + voice) | Hub impact |
|---|---|---|---|
| User notification | Telegram message | TTS spoken aloud | none — adapter swap |
| User decision | Inline button tap | Spoken response → STT → action | none — adapter swap |
| Output streaming | Telegram message updates | Spatial overlay in glasses | none — adapter swap |
| Approval contract | as above | unchanged | none |
| Worker protocol | as above | unchanged | none |
| Hub protocol | as above | unchanged | none |

Right. The architecture passes the test on paper. We will re-test it when Phase 7 is closer.

## Storage

- Hub: SQLite at `~/.wazir/hub.db` for approval history, worker registry, session metadata.
- Worker: stateless except for tmux sessions (managed by tmux itself).
- Config: YAML at `~/.wazir/config.yaml` (see `04-config-schema.md`).
- Secrets: never in YAML. Either env vars (`WAZIR_TELEGRAM_TOKEN`) or the OS keychain via `keytar`.

## Observability

- Both hub and worker log to stdout in structured JSON (pino).
- An optional log file at `~/.wazir/logs/{hub,worker}.log` rotated daily.
- A `wazir status` CLI subcommand reports: hub status, worker status, last 10 approvals, last 10 errors.

No tracing or metrics until Phase 4 — for now, logs + a status command are enough.
