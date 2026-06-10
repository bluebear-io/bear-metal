#!/usr/bin/env bash
# Run the full bear-metal stack locally with one command: dashboard backend + UI + manager
# (manager runs the worker in-process). Invoke via `npm run dev:all`. Ctrl-C tears all three down.
#
# Backend port defaults to 3100 because the UI's Vite dev proxy forwards /api -> localhost:3100
# (see src/ui/vite.config.ts). The manager reports to the backend over HTTP via DASHBOARD_URL +
# INGEST_TOKEN, so both processes are given the SAME INGEST_TOKEN here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Shared config -- override any of these via the environment before running.
export BEAR_METAL_DB_PATH="${BEAR_METAL_DB_PATH:-$ROOT/data/dashboard.sqlite}"
export BACKEND_PORT="${BACKEND_PORT:-3100}"
export INGEST_TOKEN="${INGEST_TOKEN:-dev-ingest-token}"
export DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:$BACKEND_PORT}"

# The UI is a separate npm package; install its deps on first run.
if [ ! -d "$ROOT/src/ui/node_modules" ]; then
  echo "[dev] installing UI dependencies..."
  npm --prefix "$ROOT/src/ui" install
fi

# The backend opens the dashboard DB read-write and fails fast if the file is missing. On first
# run, create + migrate it (seed:mock also loads a mock scenario so the UI isn't empty before the
# manager has written anything). Existing data is left untouched on later runs.
if [ ! -f "${BEAR_METAL_DB_PATH}" ]; then
  echo "[dev] creating + migrating dashboard DB at ${BEAR_METAL_DB_PATH}"
  mkdir -p "$(dirname "${BEAR_METAL_DB_PATH}")"
  npm run seed:mock
fi

# Kill the whole process group (all three children) on exit / Ctrl-C.
trap 'echo; echo "[dev] shutting down"; kill 0' EXIT INT TERM

echo "[dev] backend -> http://localhost:${BACKEND_PORT}/api"
echo "[dev] ui      -> http://localhost:5273"
echo "[dev] manager -> health on http://localhost:${PORT:-3000} (requires Linear/GitHub secrets in .env)"

npm run dev:backend &
npm --prefix "$ROOT/src/ui" run dev &
npm run dev &
wait
