# Wazir

A local-first supervisor for AI coding agents. Talk to your dev workflow from anywhere — today via Telegram, tomorrow via a web dashboard, eventually via AR glasses with voice.

**Wazir** (وزير) is Arabic for *vizier* — the sovereign's executor who handles day-to-day affairs on their behalf. The name fits: the system speaks for you when you're not at the keyboard, asks you when it needs a decision, and follows you wherever you go.

## Status

**Phase 0 — Architecture.** No code yet. The current artifact is this documentation. If you are an AI agent picking up this work, start at [`AGENTS.md`](./AGENTS.md).

## Document map

| File | Purpose | Read time |
|---|---|---|
| [`AGENTS.md`](./AGENTS.md) | Onboarding for any AI agent continuing this project | 2 min |
| [`docs/00-vision.md`](./docs/00-vision.md) | Problem, end-game (phone → AR glasses), non-goals | 5 min |
| [`docs/01-architecture.md`](./docs/01-architecture.md) | Hub / Worker / Interface-Adapter model and contracts | 10 min |
| [`docs/02-roadmap.md`](./docs/02-roadmap.md) | Phased delivery from Telegram MVP through AR voice | 5 min |
| [`docs/03-mvp-scope.md`](./docs/03-mvp-scope.md) | Exactly what Phase 1 ships — and what it doesn't | 5 min |
| [`docs/04-config-schema.md`](./docs/04-config-schema.md) | `~/.wazir/config.yaml` + `wazir init` flow | 3 min |
| [`docs/05-security.md`](./docs/05-security.md) | Threat model, allowlists, token storage | 5 min |
| [`docs/06-decisions.md`](./docs/06-decisions.md) | Architecture Decision Records (why each choice was made) | 10 min |

## What does Wazir do

It sits between you and your AI coding agents (Claude Code, Codex, Aider, custom scripts):

- **Intercepts dangerous commands** (`git push`, `rm`, migrations, `sudo`) and forwards them to your phone for approve / reject / modify.
- **Routes prompts** to the right agent and repository.
- **Streams output** back to whatever interface you're using.
- **Exposes a remote interface** so you can supervise development from any device — Telegram today, AR glasses eventually.

The interface layer is pluggable. The architecture deliberately treats Telegram as one of many possible adapters so the same hub can later drive a web dashboard, a voice-only adapter, or an AR/VR overlay.

## Quickstart

Nothing to run yet. Start at [`AGENTS.md`](./AGENTS.md) or [`docs/00-vision.md`](./docs/00-vision.md).

## License

TBD. Personal project for now; will likely open-source under MIT once Phase 1 ships and stabilises.
