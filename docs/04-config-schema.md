# 04 — Config Schema

A single YAML file at `~/.wazir/config.yaml`. Secrets are **not** stored here.

## Full schema (Phase 1)

```yaml
# ~/.wazir/config.yaml

version: 1

# Identity of this machine to the hub.
worker:
  id: "macbook-fay"             # required, unique across all workers on one hub
  hostname: "Fay-MBP.local"     # auto-detected if omitted
  bind_host: "127.0.0.1"        # what address the worker HTTP server listens on
  bind_port: 7843

# Hub configuration.
hub:
  bind_host: "127.0.0.1"
  bind_port: 7842
  db_path: "~/.wazir/hub.db"    # SQLite location
  # In Phase 1, hub and worker live on the same machine. Phase 5 will allow:
  #   url: "https://wazir.example.com"
  #   token_env: "WAZIR_HUB_TOKEN"

# Interface adapters to start with the hub.
adapters:
  - name: telegram
    enabled: true
    config:
      token_env: "WAZIR_TELEGRAM_TOKEN"   # name of env var holding the bot token
      allowlist:                          # only these chat IDs can interact
        - 123456789
      # Optional UX:
      use_inline_buttons: true
      max_command_chars: 1200             # commands longer than this get truncated in display

  - name: cli
    enabled: false                        # enable for local testing without Telegram

# Risk classification. Patterns are evaluated in order; first match wins.
# Empty list = no commands require approval (not recommended).
risk_patterns:
  - name: rm_force
    regex: '\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b'
    label: "rm -rf"
  - name: git_push
    regex: '\bgit\s+push\b'
    label: "git push"
  - name: sudo
    regex: '\bsudo\b'
    label: "sudo"
  # … see 03-mvp-scope.md for the full default list

# Optional: which repos this worker is responsible for. Phase 1 doesn't enforce
# anything with this — it's metadata that surfaces in the Telegram message
# context line. Later phases use it for routing.
repos:
  - name: "yourcampus-monorepo"
    path: "/Users/fay/Projects/alleo/yourcampus-monorepo"
  - name: "wazir"
    path: "/Users/fay/Projects/wazir"

# Logging.
logging:
  level: "info"                  # trace | debug | info | warn | error
  file: "~/.wazir/logs/wazir.log"
  rotate: "daily"
```

## Secrets

Secrets never live in `config.yaml`. They live in `~/.wazir/.env` with file permissions `0600`. `config.yaml` references the env var name (e.g. `token_env: WAZIR_TELEGRAM_TOKEN`); the daemons load `.env` at startup and resolve the name.

We deliberately do **not** use the macOS Keychain (or any OS-specific secret store) — see [`06-decisions.md` ADR-015](./06-decisions.md#adr-015--secrets-live-in-wazirenv-not-the-os-keychain) for the rationale. Single `.env` file = portable install (copy `~/.wazir/` to a new machine and the daemons come up).

## `wazir init` flow

The wizard creates the config file interactively:

```
$ npx wazir init
Wazir init wizard. This will create ~/.wazir/config.yaml.

? Worker ID (a short name for this machine):    macbook-fay
? Hub bind port:                                7842
? Worker bind port:                             7843

? Telegram bot token (or paste later):
  → I'll guide you: open Telegram, search @BotFather, type /newbot,
    follow the prompts, paste the token here.
  Token: ********************************

(Token is written to ~/.wazir/.env with mode 0600.)

? Now I'll send a message from your bot. Open Telegram, find
  @YourBotName, send any message, then press Enter here.
  [press Enter when ready]

  ✓ Received message from chat_id 123456789 (Fay).
  Adding 123456789 to the Telegram allowlist.

? Add another allowed chat (e.g. a second device)?  No

Writing ~/.wazir/config.yaml ...
Writing ~/.wazir/claude-hook-snippet.json ...

✅ Done.

Next steps:
  1. Open ~/.claude/settings.json (or your repo's .claude/settings.json).
  2. Merge the contents of ~/.wazir/claude-hook-snippet.json into the "hooks"
     section. Don't have a "hooks" section yet? The snippet is a complete
     replacement.
  3. In one terminal: wazir hub
  4. In another terminal: wazir worker
  5. Start Claude Code and ask it to run something risky.
```

## Generated Claude Code hook snippet

`wazir init` writes `~/.wazir/claude-hook-snippet.json` containing:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7843/v1/hooks/claude-code/pre-tool-use",
            "timeout_seconds": 540
          }
        ]
      }
    ]
  }
}
```

The user merges this into `~/.claude/settings.json` themselves. We do not mutate user-owned config files automatically.

## Versioning

`version: 1` is a hard requirement at the top. Future config schemas bump this. `wazir` refuses to start if the schema is unknown, and offers `wazir config migrate` to upgrade.

## Validation

On startup, both hub and worker validate the config against a Zod schema. Validation errors are reported with the YAML path that's wrong (e.g. `adapters[0].config.allowlist: expected number, got string`).
