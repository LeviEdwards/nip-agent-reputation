#!/bin/bash
# ensure-server.sh — Start reputation server if not running
# Called by self-attestation cron (every 6h) and heartbeats

PORT=3386
SERVER_DIR="/data/.openclaw/workspace/nip-reputation"
LOG="/tmp/reputation-server.log"

# Check if server is responding
if curl -s --max-time 3 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "Reputation server OK (port $PORT)"
  exit 0
fi

echo "Reputation server not running — starting..."
cd "$SERVER_DIR"
nohup node src/server.js --port "$PORT" >> "$LOG" 2>&1 &
NEW_PID=$!
echo "Started PID $NEW_PID"

# Wait and verify
sleep 4
if curl -s --max-time 3 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "Reputation server started OK (PID $NEW_PID)"
else
  echo "ERROR: Reputation server failed to start — check $LOG"
  exit 1
fi
