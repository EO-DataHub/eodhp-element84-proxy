#!/usr/bin/env bash
# Starts the proxy against the mock upstream, runs check.py, and stops both.
set -euo pipefail
cd "$(dirname "$0")"
trap 'docker compose down --remove-orphans >/dev/null 2>&1' EXIT
docker compose up -d --quiet-pull
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:18000/healthz >/dev/null && break
  sleep 1
done
if ! python3 -I check.py; then
  docker compose logs proxy | tail -30
  exit 1
fi
