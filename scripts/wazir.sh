#!/usr/bin/env bash
# Wrapper for one-shot wazir CLI commands. Source nvm so we run on the Node
# version pinned by .nvmrc, then exec the CLI with whatever args were passed.

set -euo pipefail

cd "$(dirname "$0")/.."

# Source nvm if available.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
elif command -v brew >/dev/null 2>&1 && [ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$(brew --prefix nvm)/nvm.sh"
fi

if command -v nvm >/dev/null 2>&1; then
  nvm use --silent >/dev/null 2>&1 || {
    echo "warning: 'nvm use' failed; the Node version in .nvmrc may not be installed."
    echo "         run 'nvm install' once, then retry."
    exit 1
  }
elif command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd)"
fi

# install-service writes plists that point at packages/cli/dist/bin.js, so make
# sure dist/ is current. tsc -b is incremental and fast on warm builds.
if [ "${1:-}" = "install-service" ]; then
  echo "building workspace packages..."
  node_modules/.bin/tsc -b \
    packages/protocol \
    packages/adapter-cli \
    packages/adapter-telegram \
    packages/hub \
    packages/worker \
    packages/cli
fi

exec node_modules/.bin/tsx packages/cli/src/bin.ts "$@"
