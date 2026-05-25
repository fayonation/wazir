# AGENTS.md — onboarding for AI agents

If you are an AI agent (Claude Code, Cursor, Codex, etc.) picking up work on **Wazir**, read this file first. It exists so that any agent — in any session, on any machine — can continue the project without context loss.

## Project state

**Phase 0 — Architecture only.** No source code exists yet. The current artifact is the documentation in `docs/`. The next milestone is **Phase 1: Telegram Approval Bridge MVP** (see `docs/03-mvp-scope.md`).

## Read in this order

Don't skip. The docs build on each other.

1. [`README.md`](./README.md) — 1 min. What Wazir is, status.
2. [`docs/00-vision.md`](./docs/00-vision.md) — 5 min. The problem and end-game.
3. [`docs/01-architecture.md`](./docs/01-architecture.md) — 10 min. Hub/Worker/Adapter contracts.
4. [`docs/02-roadmap.md`](./docs/02-roadmap.md) — 5 min. Phased delivery.
5. [`docs/03-mvp-scope.md`](./docs/03-mvp-scope.md) — 5 min. What Phase 1 actually ships.
6. [`docs/06-decisions.md`](./docs/06-decisions.md) — 10 min. ADRs (why each tech choice was made).

Consult [`04-config-schema.md`](./docs/04-config-schema.md) and [`05-security.md`](./docs/05-security.md) when implementing.

## Hard rules

These are non-negotiable. Violating them means rewriting later.

1. **Do not skip phases.** Phase 1 is *Telegram approval bridge only*. Voice, screenshots, tunneling, `@agent` routing, web dashboard, AR — all later phases. Adding them now means shipping nothing.
2. **The interface layer is pluggable.** Telegram is the Phase 1 adapter. Web (Phase 4) and AR/voice (Phase 7) are future adapters speaking the same hub protocol. Do not bake Telegram concepts into the hub core.
3. **Hub ↔ Worker is a network protocol from day one.** Even on a single machine, hub and worker talk over HTTP/WebSocket on localhost. This is what enables the future migration to a Raspberry Pi or VPS hub without a rewrite.
4. **Source-agnostic webhook contract.** Claude Code is the first agent we support. The hub must not assume any Claude-Code-specific concepts; everything goes through the generic `/v1/approvals` contract documented in `01-architecture.md`.
5. **Cross-platform via thin adapters.** Mac/Linux native, Windows via WSL2. OS-specific code (screenshots, native notifications) lives in a `platform/` module. The core is portable.
6. **No autonomous execution.** Wazir is a *supervisor*. Dangerous commands require explicit human approval. Never bypass the approval layer for "convenience."
7. **Verify before claiming done.** No "task complete" without confirming the code compiles, types check, and the change does what was asked. If a check doesn't exist for what you changed, say so explicitly.

## What to do if you're continuing the work

- **If Phase 1 implementation has not started yet:** do not write code. Refine docs based on user feedback first. The current focus is making the architecture solid enough that implementation is mechanical.
- **If Phase 1 is in progress:** see `docs/03-mvp-scope.md` for the exact deliverable. Stick to the scope. If something seems missing, propose adding it as a Phase 2+ item, don't smuggle it into Phase 1.
- **If docs are ambiguous or contradict each other:** flag it to the user, do not guess. Then resolve by updating docs, not by silent reinterpretation.
- **If you think a better architecture exists:** write an ADR in `06-decisions.md` proposing the change. Do not change design silently.

## Cross-session continuity

Wazir is being designed across multiple chat sessions and possibly across multiple AI agents. Capture every meaningful decision in `06-decisions.md` so the next session/agent inherits it. Tribal knowledge in chat history is lost; ADRs are durable.

When in doubt about a past decision: search ADRs first, ask the user second, assume third (and only as a last resort, with an explicit flag).

## Out-of-scope reminders

The following are **explicitly not Wazir's job**:

- Being a general LLM chatbot interface.
- Replacing claude.ai/code or Anthropic's official Remote Control (Feb 2026). Wazir's value is the *supervisor/approval/routing layer*, not session viewing.
- Enterprise features: SSO, RBAC, compliance audit logs.
- Hosting agents in the cloud. Wazir is local-first; the hub may later run on a Pi or small VPS, but it's never a SaaS.

## Project conventions

- **Language:** TypeScript (strict). Node ≥ 20.
- **Package manager:** pnpm (workspaces).
- **Style:** match repository ESLint/Prettier when configured. For new files, prefer relative imports within a package, no default exports for utilities.
- **Tests:** Vitest. Adapters get integration tests; core gets unit tests.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`). One logical change per commit.
- **Branches:** `phase-N-<topic>` (e.g. `phase-1-telegram-bridge`).
