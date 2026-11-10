#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -x "$ROOT/backend/.venv/bin/python" ] || { python3 -m venv "$ROOT/backend/.venv"; "$ROOT/backend/.venv/bin/pip" install -q -e "$ROOT/backend[dev]"; }
[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm install)
(cd "$ROOT/backend" && .venv/bin/uvicorn app.main:get_app --factory --host 127.0.0.1 --port 8000) &
API=$!
(cd "$ROOT/frontend" && npm run dev) &
WEB=$!
trap 'kill $API $WEB 2>/dev/null' EXIT
echo "Ouvrir http://localhost:5173"
wait
