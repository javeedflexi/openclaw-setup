#!/usr/bin/env bash
# sync.sh <local_dir> <bucket> <prefix>
# Pushes local openclaw state to R2. Called by entrypoint on SIGTERM + cron.
set -euo pipefail

LOCAL_DIR="${1:?local dir required}"
BUCKET="${2:?bucket required}"
PREFIX="${3:?prefix required}"

echo "[sync] Pushing ${LOCAL_DIR} → r2:${BUCKET}/${PREFIX}/"

rclone sync \
  "${LOCAL_DIR}/" \
  "r2:${BUCKET}/${PREFIX}/" \
  --exclude ".lock" \
  --exclude "*.tmp" \
  --transfers=8 \
  --fast-list \
  --stats=0 \
  2>&1 | sed 's/^/[rclone push] /'

echo "[sync] Done"
