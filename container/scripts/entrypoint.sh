#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-changeme}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"

mkdir -p "${STATE_DIR}/workspace"

cat > "${STATE_DIR}/openclaw.json" <<EOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": "${TOKEN}"
    }
  }
}
EOF

export OPENCLAW_STATE_DIR="${STATE_DIR}"
export ANTHROPIC_API_KEY="${ANTHROPIC_KEY}"

exec node /app/dist/index.js gateway \
  --port 18789 \
  --bind custom \
  --custom-bind-host 0.0.0.0 \
  --allow-unconfigured \
  --token "${TOKEN}"