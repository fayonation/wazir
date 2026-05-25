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

## Phase 2 — Bidirectional voice over tmux-managed sessions

Phase 2 turns Wazir from a *supervisor* (Phase 1) into a *remote interface*. The user can talk to their agent from Telegram and hear it talk back, without being at the keyboard.

**Architectural foundation (locked in `06-decisions.md`):**
- **[ADR-011](./06-decisions.md#adr-011--tmux-is-the-canonical-agent-session-container)** — every agent session Wazir manages runs in a Wazir-spawned tmux pane. The worker uses `tmux send-keys` to inject input and `tmux capture-pane` to read output. This is the only viable prompt-injection path (no first-party API exists) and it generalises across agent CLIs.
- **[ADR-012](./06-decisions.md#adr-012--local-first-principle-no-required-cloud-dependencies)** — no required cloud dependencies. STT and TTS run locally by default.
- **[ADR-013](./06-decisions.md#adr-013--local-whispercpp-as-default-stt-supersedes-adr-007)** — STT via local `whisper.cpp` (base.en model). OpenAI Whisper API opt-in.
- **[ADR-014](./06-decisions.md#adr-014--piper-as-default-tts)** — TTS via local `piper`. Cloud TTS opt-in.

**Deliverables:**

1. **`@wazir/worker` gains a `tmux/` module.**
   - `spawnSession({ agent, cwd, env }) → sessionId` (runs e.g. `tmux new-session -d -s wazir-claude-<id> "claude"`)
   - `listSessions()` / `sessionStatus(id)` / `killSession(id)`
   - `sendInput(id, text)` (newline-handled `tmux send-keys`)
   - `capturePane(id, { sinceLastRead }) → string` (delta read against a per-session cursor)
   - Locking: while Wazir is delivering a transcribed prompt, the worker holds a per-session lock so concurrent user-typed input doesn't interleave.

2. **`@wazir/worker` gains a `transcription/` module.**
   - Default: shells out to a bundled `whisper.cpp` with `base.en`. First-run wizard offers `wazir install-models` to fetch the binary + model if not present.
   - Opt-in: OpenAI Whisper API (`transcription.provider: openai`, key in keychain).
   - Input: any format Telegram delivers (ogg/opus typically). Decode via `ffmpeg` if needed.

3. **`@wazir/worker` gains a `tts/` module.**
   - Default: `piper` → opus → Telegram `sendVoice`. Defaults to a single bundled English voice; configurable.
   - Opt-in: ElevenLabs / OpenAI TTS.
   - Reply modality mirrors input: voice in → voice reply; text in → text reply. User can override per-chat via `/voice on|off`.

4. **`@wazir/hub` gains a "session" entity.**
   - The hub tracks active sessions across workers (sessionId, workerId, agent type, cwd, current pane snapshot timestamp).
   - The Telegram adapter knows which session a given chat is currently focused on; new voice notes get routed to that session's worker.
   - **cwd resolution:** sticky-per-chat. The hub remembers the last `cwd` the user `/new`'d in for each chat and reuses it. A `/cwd <path>` command overrides for subsequent `/new`s. Initial fallback when a chat has no history: a config-defined `default_session_cwd` (e.g. `~/Projects`).
   - **Session id ownership:** Wazir generates a UUID and passes it via `claude --session-id <uuid>` so the id is stable across resume/fork. Concurrency guard: one tmux pane per session id at any time; `/resume` on an already-open id is a focus-switch, not a respawn.

5. **`@wazir/adapter-telegram` gains voice handling and session commands.**
   - On `message:voice`: download → transcribe → forward to hub as a prompt-delivery request → hub picks the active session for this chat → worker `send-keys`.
   - On worker pane output: hub fans out to adapter → adapter posts as Telegram text (default) or `sendVoice` (when reply modality is voice).
   - **Commands** (one active session per chat):
     - `/new [name]` — spawn fresh session in the chat's sticky cwd, becomes active.
     - `/list` — list sessions for the chat's cwd (number, label = first user prompt truncated, last activity, message count, ★ on active).
     - `/resume <n|id|name>` — switch active session, post a **cheap summary**: first user prompt + last assistant turn + message count (no LLM call, parsed from JSONL).
     - `/clear` — `tmux send-keys` `/clear` into the active pane; keeps the session id.
     - `/end` — kill the active tmux pane; clear active-session pointer.
     - `/cwd <path>` — change the chat's sticky cwd; takes effect on next `/new`.
     - `/voice on|off` — override reply modality (default mirrors input).
     - `/say <text>` — send text as if it were a voice note.

6. **`@wazir/cli` gains session management.**
   - `wazir session new <agent>` / `list` / `attach <id>` / `kill <id>`.
   - `wazir install-models` downloads `whisper.cpp` and the Piper voice on first run.

7. **`@wazir/worker` gains screenshots (preserved from the original Phase 2 plan).**
   - `/screen` Telegram command → `screencapture` on macOS / `grim`/`scrot` on Linux → upload to Telegram.

**Acceptance:**

A user with Phase 1.5 already installed can:
1. Run `wazir install-models` once.
2. Send `/new claude` in Telegram. Wazir spawns `tmux new-session -d -s wazir-claude-<id> "claude"` on the configured worker.
3. Send a voice note in Telegram: *"What's the failing test in the auth middleware?"*
4. Within ~2 seconds, the transcription appears as a typed user prompt in the Claude Code session (`tmux send-keys`), Claude responds, and the response is streamed back to Telegram as text.
5. Send `/voice on` then another voice note: response now comes back as a Telegram voice message in addition to text.
6. The Phase 1 approval flow still works unchanged — if Claude tries `git push`, it goes through the same approve/reject/modify path.

**Non-goals for Phase 2:** multi-agent routing (`@backend-agent ...` is Phase 6), web dashboard (Phase 4), wake-word activation (Phase 7), high-quality / human-sounding TTS (Phase 7 polish), natural-language session switching (Phase 2.5 — see below).

## Phase 2.5 — Natural-language session control

Small follow-on after Phase 2 ships. Lets the user say *"switch me back to the auth refactor conversation"* in plain English instead of `/resume 3`. Implementation: a small LLM call against the session list (label + last assistant turn) that fuzzy-matches the user's request to a session id, or returns "no match — here are your sessions." Same chat surface, no new tmux/adapter/hub plumbing required; lives entirely inside the Telegram adapter's routing logic. Also folds in LLM-summarized session recaps on `/resume` if the cheap recap from Phase 2 turns out to be too thin.

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
- **Surface the active model in approval messages.** Claude Code's `PreToolUse` hook payload doesn't include the model name, but the transcript file at `transcript_path` does (each JSONL message has a `model` field). The worker should peek at the last few lines of the transcript and add a `model` field (e.g. `claude-sonnet-4-6`) to the approval `context`, which the Telegram adapter renders as a third line under the command. Cache the read result per `session_id` to avoid re-parsing the transcript on every approval. Optional follow-on: also surface `cwd`'s git branch and dirty state.
