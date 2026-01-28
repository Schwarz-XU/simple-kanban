#!/bin/zsh
set -euo pipefail
cd /Users/bobminions/clawd/kanban-bob
exec /usr/local/bin/uv run python app.py
