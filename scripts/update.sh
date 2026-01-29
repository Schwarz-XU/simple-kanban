#!/usr/bin/env bash
set -euo pipefail

# Update + restart helper for Linux/WSL systemd user service.
# Usage:
#   ./scripts/update.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Updating repo"
git pull

if command -v uv >/dev/null 2>&1; then
  echo "==> Syncing dependencies (uv)"
  uv sync
else
  echo "==> uv not found on PATH; skipping dependency sync"
fi

if command -v systemctl >/dev/null 2>&1; then
  echo "==> Restarting kanban.service (systemd --user)"
  systemctl --user restart kanban.service
  systemctl --user --no-pager status kanban.service || true
else
  echo "==> systemctl not found; skipping service restart"
fi

echo "==> Done"
