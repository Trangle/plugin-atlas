#!/usr/bin/env bash
set -euo pipefail
WEB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$WEB_DIR/.pid" ]]; then
 WEB_PID="$(cat "$WEB_DIR/.pid")"
 if kill -0 "$WEB_PID" 2>/dev/null && [[ "$(readlink -f "/proc/$WEB_PID/cwd" 2>/dev/null || true)" == "$WEB_DIR" ]] && tr '\0' ' ' < "/proc/$WEB_PID/cmdline" | grep -q 'node server.mjs'; then kill "$WEB_PID"; for _ in $(seq 1 50); do kill -0 "$WEB_PID" 2>/dev/null || break; sleep 0.2; done; kill -0 "$WEB_PID" 2>/dev/null && kill -9 "$WEB_PID"; fi
 rm -f "$WEB_DIR/.pid"
 echo "已停止"
else echo "未运行"; fi
