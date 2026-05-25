#!/usr/bin/env bash
# Wrapper for `pnpm dev` that ensures we're on the Node version pinned by .nvmrc
# before spawning the hub + worker. Sources nvm so the version switch happens
# even when the user's shell is on a different default (e.g. Node 24).

set -euo pipefail

cd "$(dirname "$0")/.."

# Source nvm if available. nvm is a shell function (not a binary) so we have to
# load it here; otherwise `nvm use` won't exist in this subshell.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
elif command -v brew >/dev/null 2>&1 && [ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]; then
  # Homebrew install path
  # shellcheck disable=SC1091
  . "$(brew --prefix nvm)/nvm.sh"
fi

if command -v nvm >/dev/null 2>&1; then
  nvm use --silent >/dev/null 2>&1 || {
    echo "warning: 'nvm use' failed; the Node version in .nvmrc may not be installed."
    echo "         run 'nvm install' once, then retry 'pnpm dev'."
    exit 1
  }
elif command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd)"
fi

NODE_VERSION="$(node --version 2>/dev/null || echo none)"
echo "wazir dev: using node $NODE_VERSION"

# Workspace packages export from dist/, so changes in packages/*/src don't appear
# under tsx without a rebuild. Build first (fast — incremental tsc -b).
echo "wazir dev: building workspace packages..."
node_modules/.bin/tsc -b \
  packages/protocol \
  packages/adapter-cli \
  packages/adapter-telegram \
  packages/hub \
  packages/worker

# Run hub + worker concurrently. We invoke binaries from node_modules directly
# (not via pnpm) so we don't trigger pnpm's engine check on the wrong Node.
exec node_modules/.bin/concurrently \
  --kill-others-on-fail \
  --names hub,worker \
  --prefix-colors cyan,magenta \
  "node_modules/.bin/tsx packages/cli/src/bin.ts hub" \
  "node_modules/.bin/tsx packages/cli/src/bin.ts worker"
