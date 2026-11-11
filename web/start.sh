#!/usr/bin/env bash
set -euo pipefail
WEB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${ATLAS_LOG_DIR:-$(dirname -- "$WEB_DIR")/logs}"
if [[ -f "$WEB_DIR/.pid" ]] && kill -0 "$(cat "$WEB_DIR/.pid")" 2>/dev/null; then echo "已运行 PID $(cat "$WEB_DIR/.pid")"; exit 0; fi
mkdir -p "$LOG_DIR"
cd "$WEB_DIR"
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${ATLAS_HEAP_MB:-8192}" setsid nohup node server.mjs >> "$LOG_DIR/web.log" 2>&1 < /dev/null &
WEB_PID=$!
echo "$WEB_PID" > "$WEB_DIR/.pid"
sleep 1
if ! kill -0 "$WEB_PID" 2>/dev/null; then rm -f "$WEB_DIR/.pid"; echo "启动失败，查看 logs/web.log"; exit 1; fi
echo "已启动 PID $WEB_PID，端口 ${PORT:-4380}"
