# 02 — Roadmap

Phases are ordered, not dated. We ship Phase N before starting Phase N+1. If a phase takes a weekend, great. If it takes a month, also fine — but no skipping ahead.

## Phase 0 — Architecture (in progress)

This documentation. No code.

**Exit criteria:** docs are clear enough that any AI agent can pick up Phase 1 and start implementing without ambiguity.

## Phase 1 — Telegram Approval Bridge (the MVP)

The smallest thing that delivers the core value.

**Deliverables:**
- `@wazir/protocol` — shared TypeScript types (HubNotification, ApprovalRequest, etc.)
- `@wazir/hub` — Express daemon, SQLite, hosts adapters.
- `@wazir/worker` — Express daemon, exposes `/hook` for Claude Code, classifies risk, forwards to hub.
- `@wazir/adapter-telegram` — Telegraf bot with inline buttons, chat-ID allowlist.
- `@wazir/adapter-cli` — for testing without Telegram (renders to stdout).
- `@wazir/cli` — `wazir init`, `wazir hub`, `wazir worker`, `wazir status`.

**Acceptance:** see `03-mvp-scope.md`.

## Phase 2 — Voice notes, screenshots, output streaming

- Voice messages from Telegram → Whisper API → injected as prompt into the active session.
- `/screen` command → screenshot of active display (uses worker's `platform/` module).
- Streaming tmux pane output back to Telegram (chunked, throttled, edited in place where possible).

**New components:** `@wazir/adapter-telegram` gains voice handling; worker gains `screenshot.*.ts` platform files. No hub changes.

## Phase 3 — Localhost tunneling

- `/preview <port>` issues a one-shot Cloudflare Tunnel URL (or a Tailscale Funnel URL if Tailscale is configured).
- Lifetime configurable; defaults to 1 hour. Auto-revoked.

**New component:** `@wazir/tunnel` (thin wrapper over `cloudflared` and/or `tailscale serve`). No hub changes.

## Phase 4 — Web dashboard

- Browser-based control surface (React + Vite, served by the hub).
- Read-only first: view active sessions, approval history, worker status.
- Then full control: approve / reject / modify, send commands, switch sessions.

**New components:** `@wazir/adapter-web` (WebSocket adapter), `@wazir/dashboard` (the React app). Hub gains a `/dashboard` static-serving route. Approval protocol unchanged.

## Phase 5 — Portable / multi-machine hub

- The hub binary runs anywhere — Mac, Linux, Raspberry Pi 4, $5/mo VPS.
- Workers authenticate to the hub with a shared secret or token.
- Network reachability: Tailscale (recommended) or HTTPS + reverse proxy.
- One hub coordinates multiple workers across multiple machines.

**Changes:** worker config gains a remote `hub_url`; hub gains worker auth middleware. No protocol redesign — the contract was already network-shaped from Phase 1.

## Phase 6 — Multi-agent routing

- `@backend-agent fix the auth bug` is parsed by the interface adapter and routed to the configured agent/session.
- Adapter classes per source: `claude-code-adapter`, `codex-adapter`, `aider-adapter`.
- A "session" gains an `agent_type` field; workers spawn the right CLI per type.

## Phase 7 — Voice + AR (end-game)

**Target hardware:** Meta Ray-Ban Display, Apple Vision Pro 2, Xreal/Rokid AR glasses.

**Deliverables:**
- `@wazir/adapter-voice-ar` — the AR/voice adapter.
- Low-latency STT (local whisper-cpp or streaming API).
- TTS that mirrors the user's preferred voice profile.
- Spatial UI library for rendering output panes / screenshots in field of view.
- Wake word ("Wazir"), multi-agent addressing, conversational batching.

**Crucially:** no hub or worker changes are required. The protocol was designed in Phase 1 to support voice (`voice_prompt`, `voice_phrase` fields) and streaming output. If we discover we need protocol changes, that's a sign we got Phase 1 wrong — we will fix Phase 1 retroactively, not bolt onto Phase 7.

## What we explicitly defer

- Mobile native apps (iOS/Android). Telegram and the web dashboard cover this until AR.
- Plugin ecosystem / third-party adapters. We'll formalize the adapter interface for external authors only after Phase 4.
- Localization. English only through at least Phase 5.
- Per-team multitenancy. Single-user or trusted-small-team only through at least Phase 6.

## Operational polish (Phase 1.5)

Things that aren't part of the Phase 1 deliverable but are needed before this becomes a daily-driver tool. To be picked up after the Phase 1 MVP is verified working end-to-end.

- **Auto-start on machine boot.** The hub and worker should always be listening — if the laptop reboots or sleeps, they should come back without manual intervention.
  - macOS: `launchd` plist installed by `wazir install-service` (creates `~/Library/LaunchAgents/com.wazir.{hub,worker}.plist`, loads with `launchctl`).
  - Linux: systemd user units (`~/.config/systemd/user/wazir-{hub,worker}.service`, enabled with `systemctl --user enable --now`).
  - Both should log to `~/.wazir/logs/{hub,worker}.log` with daily rotation, restart on crash with exponential backoff, and depend on the user being logged in (not system-wide).
  - CLI: `wazir install-service` / `wazir uninstall-service` / `wazir service status`.
- **Shell hook for Node version.** A repo-local `direnv` or zsh `chpwd` hook so `nvm use` happens automatically on `cd`.
- **`wazir doctor`.** Single command that checks: Node version, config validity, hub reachability, worker reachability, Telegram bot reachability (calls `getMe`), hook snippet present in `~/.claude/settings.json`. Prints a pass/fail checklist.
- **Better-sqlite3 prebuilds for Node 24.** Either wait upstream, switch to the built-in `node:sqlite` (Node 22.5+), or vendor a prebuilt.
