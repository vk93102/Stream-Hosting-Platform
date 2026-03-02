#!/usr/bin/env bash
# SIL – start the backend server
# Usage: ./start.sh
set -e

# Kill anything already on port 3000
if lsof -ti :3000 >/dev/null 2>&1; then
  echo "→ Killing existing process on port 3000…"
  lsof -ti :3000 | xargs kill -9
  sleep 1
fi

echo "→ Starting SIL backend…"
exec node "$(dirname "$0")/backend/server.js"
