#!/usr/bin/env bash
# Run the full bear-metal stack locally: manager (API + worker) + UI dev server.
# Invoke via `npm run dev:all`. Ctrl-C tears both down.
#
# The manager bootstraps its schema on startup — no separate migration step required.
# BACKEND_PORT (default 3100) is where the dashboard API listens; the UI's Vite proxy
# forwards /api -> localhost:3100 (see src/ui/vite.config.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# BACKEND_PORT is needed by the shell to print the URL; DATABASE_URL is left to dotenv so
# that the value in .env is respected without being shadowed by a shell export.
export BACKEND_PORT="${BACKEND_PORT:-3100}"

# The UI is a separate npm package; install its deps on first run.
if [ ! -d "$ROOT/src/ui/node_modules" ]; then
  echo "[dev] installing UI dependencies..."
  npm --prefix "$ROOT/src/ui" install
fi

# Kill the whole process group (both children) on exit / Ctrl-C.
trap 'echo; echo "[dev] shutting down"; kill 0' EXIT INT TERM

echo "[dev] manager  -> http://localhost:${BACKEND_PORT}/api  (API + worker; requires secrets in .env)"
echo "[dev] ui       -> http://localhost:5273"

npm run dev &
npm --prefix "$ROOT/src/ui" run dev &
wait
