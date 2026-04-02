#!/usr/bin/env sh
# start.sh — OpenClaw container entrypoint
#
# R2 persistence mirrors moltbot-sandbox:
#   - On start:    rclone copy r2:<bucket>/state/<shard>/ → STATE_DIR
#   - On shutdown: rclone sync STATE_DIR → r2:<bucket>/state/<shard>/
#
# Required env vars (injected by OpenClawContainer.envVars from Worker secrets):
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, R2_BUCKET_NAME
#   OPENCLAW_GATEWAY_TOKEN, ANTHROPIC_API_KEY
#
set -eu

echo "[start] OpenClaw starting — shard=${CONTAINER_SHARD_ID:-c1}"

TOKEN="${OPENCLAW_GATEWAY_TOKEN:-changeme}"
AKEY="${ANTHROPIC_API_KEY:-}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
SHARD="${CONTAINER_SHARD_ID:-c1}"
BUCKET="${R2_BUCKET_NAME:-openclaw-sessions}"
RCLONE_CONF="${HOME}/.config/rclone/rclone.conf"
RCLONE_FLAGS="--transfers=8 --fast-list --s3-no-check-bucket"

mkdir -p "${STATE_DIR}/workspace"

# ── Configure rclone for R2 (mirrors moltbot-sandbox ensureRcloneConfig) ──────
configure_rclone() {
  if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${CF_ACCOUNT_ID:-}" ]; then
    echo "[r2] R2 credentials not set — persistence disabled"
    return 1
  fi
  mkdir -p "$(dirname "${RCLONE_CONF}")"
  cat > "${RCLONE_CONF}" << RCLONE_EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
RCLONE_EOF
  echo "[r2] rclone configured for bucket: ${BUCKET}"
  return 0
}

R2_ENABLED=0
configure_rclone && R2_ENABLED=1

# ── Restore state from R2 on startup ─────────────────────────────────────────
if [ "${R2_ENABLED}" = "1" ]; then
  echo "[r2] Restoring state from r2:${BUCKET}/state/${SHARD}/ ..."
  rclone copy \
    "r2:${BUCKET}/state/${SHARD}/" \
    "${STATE_DIR}/" \
    ${RCLONE_FLAGS} \
    --exclude "*.lock" --exclude "*.tmp" \
    2>&1 | sed 's/^/[rclone restore] /' || echo "[r2] Restore failed or no state found — starting fresh"
fi

# ── Write gateway config (only if not already restored from R2) ───────────────
if [ ! -f "${STATE_DIR}/openclaw.json" ]; then
  echo "[start] Writing gateway config (fresh start)..."
  cat > "${STATE_DIR}/openclaw.json" << CONF
{
  "env": {
    "ANTHROPIC_API_KEY": "${AKEY}"
  },
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "allowRealIpFallback": true,
    "auth": {
      "mode": "token",
      "token": "${TOKEN}"
    },
    "trustedProxies": [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "127.0.0.1",
      "::1"
    ],
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowedOrigins": ["*"],
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
CONF
else
  echo "[start] Gateway config restored from R2 — skipping overwrite"
fi

# ── Write auth-profiles.json if not already present ───────────────────────────
if [ ! -f "${STATE_DIR}/agents/main/agent/auth-profiles.json" ]; then
  echo "[start] Writing auth-profiles.json..."
  mkdir -p "${STATE_DIR}/agents/main/agent"
  cat > "${STATE_DIR}/agents/main/agent/auth-profiles.json" << AUTHEOF
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "provider": "anthropic",
      "mode": "api_key",
      "apiKey": "${AKEY}"
    }
  }
}
AUTHEOF
else
  echo "[start] Agent auth already exists — skipping"
fi

# ── Save state to R2 on shutdown (mirrors moltbot-sandbox syncToR2) ───────────
save_state() {
  if [ "${R2_ENABLED}" = "1" ]; then
    echo "[shutdown] Syncing state to r2:${BUCKET}/state/${SHARD}/ ..."
    rclone sync \
      "${STATE_DIR}/" \
      "r2:${BUCKET}/state/${SHARD}/" \
      ${RCLONE_FLAGS} \
      --exclude "*.lock" --exclude "*.log" --exclude "*.tmp" --exclude ".git/**" \
      2>&1 | sed 's/^/[rclone save] /' \
      && echo "[shutdown] State saved to R2 OK" \
      || echo "[shutdown] R2 sync failed"
  else
    echo "[shutdown] R2 not configured — skipping save"
  fi
  exit 0
}

trap save_state TERM INT

# ── Start gateway ──────────────────────────────────────────────────────────────
echo "[start] Starting OpenClaw gateway on :18789..."
exec node /app/dist/index.js gateway \
  --port 18789 \
  --bind custom \
  --allow-unconfigured \
  --token "${TOKEN}"
