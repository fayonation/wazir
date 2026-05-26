# 05 — Security

Wazir is a **local-first, single-user (or trusted-small-team) tool**. It is not a multi-tenant SaaS. The threat model and the defenses are sized accordingly: small, but real.

## Threat model

### What we defend against

1. **Random Telegram message senders.** Anyone who finds the bot's username can DM it. The bot must refuse to act on anything from outside the configured allowlist.
2. **A stolen Telegram bot token.** If the token leaks, an attacker could impersonate the bot. The allowlist prevents them from getting any *useful* response, but they could still spam approvals. We rate-limit and rotate.
3. **A compromised laptop / shared dev machine.** Anyone with shell access on the worker machine effectively owns Wazir locally; we don't try to defend against this. The user shouldn't run Wazir on a machine they don't trust.
4. **A malicious AI agent's prompt.** Claude Code (or any agent) might be jailbroken or manipulated into executing dangerous commands. Wazir's whole purpose is the human-in-the-loop gate; this is the primary defense, not a side-effect.
5. **Network sniffing on localhost.** Other processes on the same machine can sniff loopback traffic. We use a per-machine HMAC on hub↔worker requests so a rogue local process can't forge approvals.

### What we do **not** defend against

- A user who has root on the workstation. Not our problem.
- A user who deliberately approves every dangerous command without reading. That's a workflow problem, not a security problem.
- State-sponsored actors targeting an individual developer. Out of scope.
- A compromised Telegram account belonging to the legitimate user. Telegram's account security is upstream of ours.

## Defenses

### Allowlist (Phase 1)

Every adapter has an allowlist. The Telegram adapter only acts on messages where the sender's `chat_id` is in `adapters[*].config.allowlist`. Any other message is silently dropped and logged at `warn` level. No error response — we don't tell strangers the bot exists.

### Hub ↔ worker HMAC (Phase 1)

On `wazir init`, a per-installation 32-byte secret is generated and stored in the OS keychain. Every request between hub and worker carries a header:

```
X-Wazir-Signature: sha256=<HMAC(secret, raw_body + timestamp_header)>
X-Wazir-Timestamp: 1735000000
```

Server rejects if:
- signature does not match
- timestamp is more than 5 minutes off

This prevents another process on the same machine from POSTing forged approval decisions.

### Token storage (Phase 1)

Telegram bot tokens, the HMAC secret, and any future provider keys live in `~/.wazir/.env` with mode `0600`. See [ADR-015](./06-decisions.md#adr-015--secrets-live-in-wazirenv-not-the-os-keychain) for why we chose plain `.env` over the OS keychain.

Never in `config.yaml`. Never logged. `wazir status` and other diagnostics redact any string that matches `^\d{8,}:[A-Za-z0-9_-]{30,}` (Telegram token shape). The `.env` file is also listed in `.gitignore` so it can't accidentally be committed even if the user inadvertently puts a Wazir directory inside a tracked repo.

### Approval auth (Phase 1)

Every approval message includes a unique `approval_id`. The decision endpoint accepts a decision exactly once for a given `approval_id`. Duplicate or late decisions are rejected (the request has already timed out).

### Rate limiting (Phase 1)

- Hub rate-limits decision POSTs per `actor` to 60/minute.
- Worker rate-limits approval submissions per `worker_id` to 120/minute (a single risky command shouldn't fire more than once per second).

### Network exposure (Phase 1)

- Hub and worker bind to `127.0.0.1` by default. They are not reachable from the LAN.
- The Telegram bot connects outbound to Telegram's API over HTTPS. No inbound network port is opened.
- If the user enables a tunnel (Phase 3) for localhost dev-server access, that tunnel **does not** expose the hub or worker — only the dev server.

### Logging hygiene

- Bot tokens, HMAC secrets, and any field named `*_token`, `*_secret`, `password`, `authorization` are redacted in logs.
- Command bodies in approval logs are kept verbatim (you need to know what was approved), but the worker can be configured to strip env-var-style strings (`AWS_*=...`) from logs.

## Phase-specific additions

### Phase 3 (tunneling)

- `wazir tunnel <port>` warns loudly the first time and requires explicit `--yes` to expose a port publicly.
- Tunnels auto-expire (default 1 hour) and are listed by `wazir tunnel list`.
- Tunnel URLs are not logged at `info`; they are at `debug` only.

### Phase 5 (multi-machine hub)

- Workers authenticate to a remote hub with a per-worker token (not the same HMAC secret as Phase 1's local one).
- The hub exposes its API over HTTPS only, with a TLS cert (Tailscale provides one for free; Let's Encrypt for VPS deployments).
- Tokens can be revoked from the hub side without restarting workers.

### Phase 7 (voice / AR)

- Voice activation requires a wake word match plus a brief identity check (voice fingerprint or button press on the glasses). Spoken "approve" alone never triggers an irreversible action — we always confirm: "I heard 'approve the git push to main'. Say 'yes' to confirm."
- Streaming audio is never persisted by default. Transcripts may be (configurable).

## Incident response

If a token is suspected leaked:

1. `wazir token rotate` — generates a new bot token via BotFather (requires user interaction), updates the keychain entry, restarts the adapter.
2. `wazir audit --since=YYYY-MM-DD` — prints every approval decision and command run since the date.

If the HMAC secret is suspected leaked:

1. `wazir secret rotate` — generates a new HMAC secret, requires hub and all workers to restart with the new one.
