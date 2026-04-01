#!/usr/bin/env sh

echo "[start] OpenClaw starting — shard=${CONTAINER_SHARD_ID:-c1}"

TOKEN="${OPENCLAW_GATEWAY_TOKEN:-changeme}"
AKEY="${ANTHROPIC_API_KEY:-}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
SHARD="${CONTAINER_SHARD_ID:-c1}"
WORKER_URL="${OPENCLAW_WORKER_URL:-}"

mkdir -p "${STATE_DIR}/workspace"

# ── Restore state from R2 — max 5 seconds ────────────────────────────────────
if [ -n "${WORKER_URL}" ]; then
  echo "[start] Checking R2 for saved state..."
  HTTP_STATUS=$(curl -sf \
    --max-time 5 \
    -o /tmp/state.tar.gz \
    -w "%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    "${WORKER_URL}/admin/r2/restore?shard=${SHARD}" 2>/dev/null)

  if [ "${HTTP_STATUS}" = "200" ] && [ -s /tmp/state.tar.gz ]; then
    echo "[start] Restoring state from R2..."
    tar -xzf /tmp/state.tar.gz -C "${STATE_DIR}" 2>/dev/null \
      && echo "[start] State restored OK" \
      || echo "[start] State restore failed (continuing fresh)"
    rm -f /tmp/state.tar.gz
  else
    echo "[start] No saved state — fresh start"
  fi
fi

# ── Write gateway config with API key in env section ─────────────────────────
echo "[start] Writing gateway config..."
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

# ── Write auth-profiles.json with correct format ─────────────────────────────
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
  echo "[start] Auth profile written"
else
  echo "[start] Agent auth already exists — skipping"
fi

# ── Save state to R2 on shutdown ──────────────────────────────────────────────
save_state() {
  echo "[shutdown] Saving state to R2..."
  if [ -n "${WORKER_URL}" ]; then
    tar -czf /tmp/state.tar.gz \
      -C "${STATE_DIR}" \
      --exclude="./workspace" \
      --exclude="./*.log" \
      --exclude="./logs" \
      . 2>/dev/null
    if [ -s /tmp/state.tar.gz ]; then
      curl -sf --max-time 10 -X POST \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/octet-stream" \
        --data-binary @/tmp/state.tar.gz \
        "${WORKER_URL}/admin/r2/save?shard=${SHARD}" 2>/dev/null \
        && echo "[shutdown] State saved to R2 OK" \
        || echo "[shutdown] State save failed"
      rm -f /tmp/state.tar.gz
    fi
  else
    echo "[shutdown] No WORKER_URL — skipping R2 save"
  fi
  exit 0
}

trap save_state TERM INT

# ── Start gateway ─────────────────────────────────────────────────────────────
echo "[start] Starting OpenClaw gateway on :18789..."
exec node /app/dist/index.js gateway \
  --port 18789 \
  --bind custom \
  --allow-unconfigured \
  --token "${TOKEN}"