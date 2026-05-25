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

**Status:** Superseded by [ADR-013](#adr-013--local-whispercpp-as-default-stt-supersedes-adr-007). Original text kept below for history.

**Decision (superseded):** When Phase 2 adds voice transcription, the default is OpenAI's Whisper API. Local `whisper.cpp` is an opt-in alternative (set `transcription.provider: local` in config).

**Why (superseded):** Local Whisper on an already-busy MacBook (running Claude Code, builds, etc.) competes for CPU/GPU. The API is fast, cheap (~$0.006 / minute), and the privacy tradeoff is acceptable since voice notes are short user commands, not corporate IP.

**Consequences (superseded):** Phase 2 requires an OpenAI key (or another STT provider) by default. The local option keeps a privacy escape hatch.

**Why we changed our mind:** The Phase 2 design discussion locked in a stricter local-first stance ([ADR-012](#adr-012--local-first-principle-no-required-cloud-dependencies)). Requiring an OpenAI key by default contradicts that. See ADR-013 for the new default.

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

## ADR-011 — tmux is the canonical agent-session container

**Status:** Accepted (Phase 2 design)

**Decision:** Every agent session that Wazir supervises (Claude Code first, Codex/Aider/anything else later) runs inside a Wazir-managed tmux session named `wazir-<source>-<id>` (e.g. `wazir-claude-a1b2c3`). The worker spawns these sessions, tracks them, and is the only process that uses `tmux send-keys` and `tmux capture-pane` to inject input and read output.

**Why:**
- The research in Phase 2 (see PR for Phase 2 design) found no first-party API to inject prompts into a *running* Claude Code session. Anthropic's Remote Control is cloud-routed; the Agent SDK only spawns headless sessions; the `UserPromptSubmit` hook can append context but not replace the prompt. tmux + `send-keys` is the only mechanism that delivers voice notes as actual user prompts in the user's interactive session.
- It makes the worker the source of truth for "what sessions exist." Telegram (Phase 2), web dashboard (Phase 4), AR glasses (Phase 7) all read/write through the same primitive — they never talk to Claude Code directly.
- It generalises beyond Claude Code for free. `wazir-codex-...`, `wazir-aider-...`, `wazir-shell-...` are all the same shape. This deepens ADR-003.
- The user owns the tmux. Wazir doesn't replace the tmux they use day-to-day; it manages its own. A normal terminal can still `tmux attach -t wazir-claude-a1b2c3` to look at what's happening.

**Alternatives considered:**
- **node-pty + in-process PTY.** Loses the ability to attach a human terminal to the same session — a critical debug affordance. Loses crash resilience (if Wazir dies the session dies).
- **Anthropic Remote Control reverse-engineering.** Cloud-routed and undocumented; would lock us to Anthropic.
- **Per-IDE plugins (VS Code extension API).** Not local-first, surface is undocumented, would have to be re-done for every IDE.

**Consequences:**
- The worker gains a `tmux/` module: `spawnSession`, `listSessions`, `sendInput`, `capturePane`, `killSession`.
- New CLI: `wazir session new <agent>` / `wazir session list` / `wazir session attach <id>` / `wazir session kill <id>`.
- Workers without tmux installed (Windows-native, not WSL) cannot run Phase 2+ features. Documented as a known constraint; WSL2 covers the gap.
- The "active session" concept moves into the hub (so the Telegram adapter knows which session a voice note targets).
- Footguns: programmatic input to an Ink-based TUI can race with concurrent human typing. Mitigation: when Wazir is delivering a transcribed prompt, briefly lock the pane (a small banner / debounce window) before `send-keys` and unlock on the next render tick. Document the constraint that hand-typing while Telegram is mid-delivery may interleave.

---

## ADR-012 — Local-first principle (no required cloud dependencies)

**Status:** Accepted (Phase 2 design — formalizes a previously implicit principle)

**Decision:** Wazir's core supervisor functionality MUST work with no network connection beyond Telegram's bot API (which is the user's chosen surface, not a vendor lock-in). Every feature that *could* be implemented with a cloud API MUST also have a working local implementation, and the local one MUST be the default. Cloud providers are always opt-in via explicit config.

**Why:**
- The user has stated they want Wazir to be "as independent from outside services as possible, self-sufficient, install the app on any machine and it runs." Hard-coding cloud defaults erodes that.
- The end-state (Phase 7 AR + voice) is most useful exactly when the user is offline / off-network — walking, gym, transit. Phase 2 design choices that assume connectivity rule out the Phase 7 use case retroactively.
- A working local default lowers the activation cost for new users — no API keys, no billing, no signup. The MVP for any new install is "one binary, one config file, it works."
- It removes a class of failure mode (vendor outages, billing lapses, API deprecations) from anything that matters for safety (approvals) or daily use (voice).

**Alternatives considered:**
- **Cloud-first with local fallback (the prior position in [ADR-007](#adr-007--whisper-api-in-phase-2-not-local-whispercpp)).** Cheap to ship, but path-dependent: once defaults are cloud, "opt-in local" rots because no one tests it. Rejected.
- **Cloud-only.** Lower engineering cost, ruled out by the user's explicit preference.

**Consequences:**
- Default STT is `whisper.cpp` (see [ADR-013](#adr-013--local-whispercpp-as-default-stt-supersedes-adr-007)).
- Default TTS is `piper` (see [ADR-014](#adr-014--piper-as-default-tts)).
- Future capabilities (image OCR, embeddings, search, etc.) follow the same rule: ship the local path first, expose an API option behind a config switch.
- Adds a non-trivial install footprint (`whisper.cpp` models are ~150 MB, Piper voices are ~30 MB). Acceptable.
- `wazir doctor` should verify that each enabled-local feature has its model/binary present, with a clear "run `wazir install-models`" remediation when missing.

---

## ADR-013 — Local `whisper.cpp` as default STT (supersedes ADR-007)

**Status:** Accepted (Phase 2 design)

**Decision:** Wazir's default speech-to-text provider is local `whisper.cpp` with the small or base English model bundled (or downloaded on first run). The OpenAI Whisper API remains available as an opt-in via `transcription.provider: openai` in config, primarily for users on extremely low-power machines (Raspberry Pi hub deployments).

**Why:**
- Required by [ADR-012](#adr-012--local-first-principle-no-required-cloud-dependencies).
- Modern Macs (M1+) transcribe a 10-second voice note in well under a second on the `base.en` model. Latency budget for "voice note arrives → prompt typed into tmux" is fine.
- Privacy: voice notes can contain sensitive product / personal context. Keeping audio on-device removes the data-leakage failure mode entirely.

**Alternatives considered:**
- **OpenAI Whisper API as default (original ADR-007).** Cheaper to integrate, less to install. Rejected per ADR-012.
- **`whisper.cpp` with the `tiny` model (faster, less accurate).** Considered as the default, but `base.en` is the right tradeoff for short command-style voice notes.
- **Faster-Whisper / WhisperX / Distil-Whisper.** Better accuracy or speed, but heavier dependencies (Python, CUDA on some). `whisper.cpp` is a single C++ binary with no runtime — wins for the "ships on any laptop" requirement.

**Consequences:**
- Worker gains a `transcription/` module that shells out to `whisper.cpp` (downloaded/built on first install).
- `wazir doctor` checks for the whisper binary and the model file; `wazir install-models` fetches them.
- Bundle increases by ~150 MB after first run (model weights). Acceptable.
- If the user opts into the OpenAI provider, the key lives in keychain (same pattern as Telegram).

---

## ADR-014 — Piper as default TTS

**Status:** Accepted (Phase 2 design)

**Decision:** Wazir's default text-to-speech provider for replying to the user via Telegram audio is `piper` running locally. The user has explicitly accepted a robotic voice for MVP; quality upgrades are a Phase 7 polish item, not a blocker.

**Why:**
- Required by [ADR-012](#adr-012--local-first-principle-no-required-cloud-dependencies).
- The user has prior production experience with Piper in a similar project ("openclaw") and it shipped successfully.
- Piper is one C++ binary plus a small `.onnx` voice model (~30 MB). It runs in real-time on commodity hardware (sub-100ms per sentence on M1). No GPU, no runtime.
- Latency is critical for the Phase 7 (AR voice) use case. Cloud TTS (ElevenLabs, OpenAI) adds 300–800ms of round-trip even with streaming, plus per-character billing. Local Piper sidesteps both.

**Alternatives considered:**
- **macOS native `say` command + AVSpeechSynthesizer.** OS-locked, breaks ADR-012 (the hub may run on a Pi or Linux VPS in Phase 5).
- **ElevenLabs / OpenAI TTS API.** Higher quality, but external dependency + cost + latency. Available as opt-in `voice_reply.provider: elevenlabs`.
- **Mimic 3 / Coqui XTTS.** Higher quality than Piper, much heavier (Python runtime, GPU helps). Reconsider in Phase 7 when latency vs. quality tradeoffs are revisited for AR.

**Consequences:**
- Worker gains a `tts/` module that pipes text → Piper → ogg/opus → Telegram audio.
- TTS is opt-in per-session by default: text replies are sent as Telegram text messages, voice replies are sent only when the user requests them (a `/voice` command or persistent toggle per-chat). This minimises noise without giving up the capability.
- If the user sends a voice note, the reply is voice by default (mirror the input modality).
- `wazir install-models` also installs the Piper voice on first run.

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
