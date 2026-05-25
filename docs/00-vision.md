# 00 — Vision

## The problem

A modern dev workflow involves AI agents that run for minutes to hours: long Claude Code sessions, multi-step refactors, test runs, builds, migrations. The dev is tied to the desk because the agents need supervision — approvals for dangerous commands, course corrections, the occasional "no, do it this way instead."

This creates dead time. Laundry, cooking, walking, the gym, the bathroom — every interruption either freezes the agent (you don't approve in time, it sits idle) or lets it run unsupervised (it does something dumb). Both are bad.

What we want: **a supervisor interface that follows me away from the desk.** I should be able to approve a `git push`, see what an agent is stuck on, send a voice note correction, and view a localhost preview — all from wherever I am, on whatever device I happen to be wearing or carrying.

## The system in one diagram

```
   Dev (phone / web / AR glasses + voice)
                  ↕
        Interface Adapter
   (Telegram • Web • Voice+AR)
                  ↕
                 Hub
   (routes, approves, registers sessions)
                  ↕
            Worker(s)
   (one per machine, executes commands)
                  ↕
   Claude Code • Codex • Aider • shell • tmux
```

Three layers, each with a clean contract to the next. Details in `01-architecture.md`.

## Phased vision

We deliberately step from "Telegram on my phone" all the way to "voice chat through AR glasses while I'm at the gym." Each phase is shippable on its own. Each phase reuses the previous one without rewriting.

### Phase 1 — Phone via Telegram (the MVP)

Async messages, inline approval buttons (Approve / Reject / Modify). Good enough for the laundry, bathroom, and kitchen cases. Workstation stays on; phone is the remote.

### Phase 2 — Voice notes, screenshots, output streaming

Voice messages from Telegram transcribed via Whisper, forwarded as prompts. `/screen` returns the active display. Streaming tmux pane output throttled into Telegram.

### Phase 3 — Localhost tunneling

Cloudflare Tunnel or Tailscale Funnel to view Vite / Next.js / dashboards on the phone browser without exposing ports.

### Phase 4 — Web dashboard

A browser-based control surface for when the phone isn't enough. Same hub, new interface adapter.

### Phase 5 — Multi-machine / portable hub

The hub moves off the laptop onto a Raspberry Pi or a $5/mo VPS. Workers register from any number of machines (your MacBook, your work laptop, a friend's machine). The hub becomes a team-wide routing point.

### Phase 6 — Multi-agent routing

`@backend-agent fix the auth bug`. `@devops-agent restart docker`. Each prefix routes to a specific tmux session or agent process. Multiple AI providers behind the same conversational interface.

### Phase 7 — Voice + AR (the end-game)

Wear AR glasses to the gym, on a walk, anywhere. Talk to agents like you'd talk to a colleague:

> "Hey Wazir, what's `backend-agent` stuck on?"  
> *(Wazir's voice in your ear)* "It hit a failing test in the auth middleware — wants to know if it should skip the test or fix the assertion."  
> "Fix the assertion. And approve the migration from earlier."  
> "Done. Migration applied, agent is re-running the test."

The glasses overlay agent output, tmux panes, and screenshots in your field of view. Hands-free, eyes-free, location-free.

**This phase is not a rewrite.** The interface-adapter pattern (`01-architecture.md`) means the AR adapter speaks the same hub protocol that Telegram speaks today. The hub doesn't know or care whether the user is looking at a phone or hearing through earbuds.

## Why this is feasible (and why now)

- **Claude Code ships HTTP hooks** with synchronous remote-approval primitives. Half of Phase 1 is wiring, not invention. (Source: code.claude.com/docs/en/hooks-guide.)
- **Anthropic shipped Remote Control** in Feb 2026 — claude.ai/code + iOS/Android apps sync with local sessions. Wazir doesn't compete with that; it adds the supervisor/approval layer on top.
- **AR hardware is converging.** Meta Ray-Bans with display, Apple Vision Pro, Xreal/Rokid glasses. Voice + ambient display is no longer sci-fi — it's hardware available at consumer prices.
- **Whisper, TTS, and small/fast voice models** are now good enough for real-time conversational voice on commodity hardware.

## Non-goals

- ❌ **Full autonomous agent execution.** Wazir is a *supervisor*. Humans stay in the approval loop. If you want autonomy, that's a different tool.
- ❌ **Enterprise complexity.** No SSO, no RBAC, no audit compliance frameworks. Single-user or small-team tool.
- ❌ **Generic chatbot.** Not for general LLM chat. Purpose-built for development workflow supervision.
- ❌ **Closed ecosystem.** Designed to wrap any agent that can call a webhook. Claude Code is first, but the contract is source-agnostic.
- ❌ **Cloud-first / SaaS.** Local-first by default. The hub runs on your machine, your Pi, or a VPS *you control*. Not Wazir's servers — there aren't any.

## End-state mental model

> "Wazir is my chief of staff for development. It speaks for me when I'm not at the keyboard, asks me when it needs a decision, and follows me wherever I go. Today through my phone. Eventually through my glasses."

Everything in `01-architecture.md` is designed to make that sentence true in stages.
