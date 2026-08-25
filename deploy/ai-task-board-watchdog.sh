#!/usr/bin/env bash
# Keep the AI Task Board web app running when no dependency rebuild is active.
# Place /etc/ai-task-board.maintenance to suspend automatic restarts.
set -u

if [ -f /etc/ai-task-board.maintenance ]; then
  exit 0
fi

if systemctl is-active --quiet ai-task-board.service; then
  exit 0
fi

# Do not fight an in-progress dependency install/build, otherwise the service
# can be started against a half-rebuilt node_modules tree.
if pgrep -f 'npm (ci|install|run build)' >/dev/null 2>&1; then
  exit 0
fi

systemctl start ai-task-board.service >/dev/null 2>&1 || true
