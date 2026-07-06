#!/bin/bash
# Orchestrates the "1 node dies mid-flash-sale" scenario:
#   1. Start a sustained k6 load test in the background (node_failure_load.js).
#   2. Once it's reached steady state (~40s in), stop one real container.
#   3. Let the cluster run 15/16 nodes for ~30s.
#   4. Restart the container, then let k6 finish its run.
#
# Run from anywhere; paths are resolved relative to this script's location.
# Watch Grafana live during the run: http://localhost:3030/d/order-number-generator
#
# Usage: bash stress/node_failure_test.sh [worker_id]   (default worker_id=3)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_DIR="$REPO_ROOT/deployments"
WORKER_ID="${1:-3}"
SERVICE="generator-$WORKER_ID"
K6_LOG="/tmp/k6_node_failure_$$.log"

echo "=== Node-failure-under-load test: killing $SERVICE mid-run ==="
echo "k6 output streaming to: $K6_LOG"

cd "$REPO_ROOT"
k6 run stress/node_failure_load.js > "$K6_LOG" 2>&1 &
K6_PID=$!
echo "k6 started (PID $K6_PID), waiting 40s for steady state..."

sleep 40

echo ">>> Stopping $SERVICE (simulating a node crash under full load) <<<"
( cd "$COMPOSE_DIR" && docker compose stop "$SERVICE" )
DOWN_AT=$(date +%s)
echo "$SERVICE stopped at $(date -d "@$DOWN_AT" '+%H:%M:%S' 2>/dev/null || date)"

echo "Leaving it down for 30s — watch Grafana for the dip/error bump now..."
sleep 30

echo ">>> Restarting $SERVICE <<<"
( cd "$COMPOSE_DIR" && docker compose start "$SERVICE" )
UP_AT=$(date +%s)
echo "$SERVICE restarted at $(date -d "@$UP_AT" '+%H:%M:%S' 2>/dev/null || date) (down for $((UP_AT - DOWN_AT))s)"

echo "Waiting for k6 to finish the remaining stages..."
wait "$K6_PID"

echo ""
echo "=== Done. Full k6 summary: ==="
tail -40 "$K6_LOG"
