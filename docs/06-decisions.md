# 06 — Architecture Decision Records

Each ADR captures a decision, why it was made, and what we considered. Format: short. Future agents should write new ADRs rather than silently changing course.

---

## ADR-001 — Node.js + TypeScript for the core

**Status:** Accepted (Phase 0)

**Decision:** All Wazir packages are TypeScript, run on Node ≥ 20, managed with pnpm workspaces.

**Alternatives considered:**
- **Python (FastAPI + python-telegram-bot).** Equally viable. Rejected because Telegraf has a slightly cleaner inline-button API and the user already has a heavy JS/TS ecosystem (YourCampus monorepo, Vite, Next.js). Polyglot dev environments are friction we don't need on a personal tool.
- **Go.** Smaller binaries, easier distribution, but worse ecosystem for the AI-tool side (Whisper bindings, OpenAI/Anthropic SDKs). Defer until/unless Phase 5's portable hub justifies it.
- **Rust.** Overkill for what is mostly an HTTP server with a Telegram client.

**Consequences:** Distribution is via `pnpm install` from source for now. Phase 5 may revisit (likely with `bun build --compile` or similar to ship a single binary).

---

## ADR-002 — Hub and Worker as separate processes, even on a single machine

**Status:** Accepted (Phase 0)

**Decision:** Hub and Worker are separate Node processes communicating over HTTP, even when they run on the same MacBook. The protocol is the same one used in Phase 5 when the Hub moves to a Pi or VPS.

**Alternatives considered:**
- **Single combined process.** Simpler in Phase 1. Rejected because every "later we'll extract it" project rots in step one. Pay the small cost now (two processes, two ports) to make Phase 5 a config change instead of a rewrite.
- **IPC over Unix sockets in Phase 1.** Marginal performance win, but socket vs HTTP at this volume is irrelevant, and switching transports later changes the test surface.

**Consequences:** Two daemons to run. Both bind to `127.0.0.1` in Phase 1. HMAC signing (`05-security.md`) protects loopback traffic.

---

## ADR-003 — Source-agnostic webhook contract

**Status:** Accepted (Phase 0)

**Decision:** The Hub's approval API does not know about Claude Code specifically. It accepts a generic `{request_id, source, command, context, callback_url}` shape. Source-specific translation happens in the Worker (e.g. the Claude Code Hook adapter inside the Worker maps `PreToolUse` payloads to this shape).

**Alternatives considered:**
- **Bake Claude Code shapes into the Hub directly.** Faster to ship Phase 1. Rejected because the user is explicit about wanting this to wrap any agent (Codex, Aider, custom scripts) eventually. The contract takes ~30 lines extra; the lock-in costs hours later.

**Consequences:** Each new agent type means a small adapter inside the Worker. The Hub never changes.

---

## ADR-004 — Interface adapter pattern, not Telegram-first design

**Status:** Accepted (Phase 0)

**Decision:** The Hub renders notifications to a transport-neutral shape (with `label`, `voice_prompt`, `voice_phrase` fields). Adapters translate. Telegram, Web, AR/Voice all implement the same `InterfaceAdapter` interface.

**Why:** Phase 7 (AR + voice) must not require a hub rewrite. Designing the Phase 1 protocol around Telegram inline buttons would have locked us in.

**Cost:** ~20% more API surface in Phase 1 (the `voice_*` fields are unused). Worth it.

**Consequences:** Adding a new interface (web, voice, future things) is creating a new package with a known interface, not modifying the core.

---

## ADR-005 — Why "Wazir"

**Status:** Accepted (Phase 0)

**Decision:** The project is named Wazir (وزير), Arabic for *vizier* — historically, the sovereign's executor who handled day-to-day affairs and made decisions on behalf of the ruler.

**Why:** The name matches the system's actual role (executes for you when you're absent, asks when it needs a decision), has cultural depth without being obscure to non-Arabic speakers, and is short enough to be a good CLI name (`wazir init`, `wazir hub`).

**Alternatives considered:** Wakil (agent/proxy — close runner-up; rejected for slightly less recognizable archetype), Bawwab (gatekeeper — good but narrower to just the approval-bridge concept), Hakam (judge — also narrow), Diwan (administrative council — too institutional).

---

## ADR-006 — tmux on Mac/Linux, WSL2 on Windows (no native Windows in Phase 1)

**Status:** Accepted (Phase 0)

**Decision:** Phase 1 targets Mac and Linux natively. Windows users run the Worker inside WSL2.

**Why:** tmux is Unix-only. Replacing it with an in-process PTY library (`node-pty`) loses crash resilience and the ability to detach/attach human terminals to the same sessions. The benefit of native Windows isn't worth the architecture cost in Phase 1; WSL2 is universal among Windows devs.

**Consequences:** Documented as "WSL2 required on Windows" in `README.md`. If a Windows-native worker becomes important, it's a Phase 5+ item and gets its own ADR.

---

## ADR-007 — Whisper API in Phase 2, not local whisper.cpp

**Status:** Proposed (Phase 2 — not yet implemented)

**Decision:** When Phase 2 adds voice transcription, the default is OpenAI's Whisper API. Local `whisper.cpp` is an opt-in alternative (set `transcription.provider: local` in config).

**Why:** Local Whisper on an already-busy MacBook (running Claude Code, builds, etc.) competes for CPU/GPU. The API is fast, cheap (~$0.006 / minute), and the privacy tradeoff is acceptable since voice notes are short user commands, not corporate IP.

**Consequences:** Phase 2 requires an OpenAI key (or another STT provider) by default. The local option keeps a privacy escape hatch.

---

## ADR-008 — SQLite for Hub persistence

**Status:** Accepted (Phase 0)

**Decision:** Hub state (approval history, worker registry, session metadata) lives in SQLite at `~/.wazir/hub.db`. We use `better-sqlite3` for synchronous reads (fine for our query volume).

**Alternatives considered:**
- **Postgres.** Overkill for personal/team scale. Adds an external dependency to install.
- **Just JSON files.** Insufficient for query patterns even in Phase 1 (e.g. "show last 10 approvals" needs ordering and indexing).

**Consequences:** Easy to back up (one file). Phase 5 may need to switch to Postgres when the hub is multi-tenant on a VPS — that's an explicit deferral.

---

## ADR-009 — Synchronous HTTP hooks, not async polling

**Status:** Accepted (Phase 0)

**Decision:** Claude Code's PreToolUse HTTP hook will block (up to 9 minutes) waiting for the worker → hub → adapter → user → back round trip. No async/polling architecture.

**Why:** Claude Code natively supports synchronous HTTP hooks with 600s timeout. The whole approval flow fits inside that. Building our own async queue + polling layer is unnecessary complexity.

**Consequences:** Hub and Worker keep one open HTTP connection per pending approval. With a single user and a typical small number of in-flight approvals, this is trivially within Node's capabilities.

---

## ADR-010 — pnpm workspaces, single repo

**Status:** Accepted (Phase 0)

**Decision:** Wazir is one git repo with multiple packages under `packages/`, managed by pnpm workspaces. Not Nx, not Turborepo, not separate repos.

**Why:** pnpm workspaces are zero-config and fast. Nx/Turborepo's task-graph features are unnecessary for ~6 packages with linear dependencies. Separate repos add overhead for a tightly coupled set of packages.

**Consequences:** We may revisit if Phase 6 introduces many independently-released agent adapters.

---

## ADR template for future entries

```
## ADR-NNN — <title>

**Status:** Proposed | Accepted | Superseded by ADR-XXX

**Decision:** <one sentence>

**Why:** <2–4 sentences>

**Alternatives considered:** <bullets>

**Consequences:** <what changes for future work>
```

Write new ADRs rather than editing existing accepted ones. If superseding, mark the old one and link both ways.
