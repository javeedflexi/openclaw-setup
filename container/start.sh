#!/usr/bin/env sh
set -e

mkdir -p ${OPENCLAW_STATE_DIR}/workspace

cat <<EOF > ${OPENCLAW_STATE_DIR}/openclaw.json
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  }
}
EOF

echo "Starting OpenClaw gateway..."

exec node /app/dist/index.js gateway \
  --port 18789 \
  --bind custom \
  --allow-unconfigured \
  --token "${OPENCLAW_GATEWAY_TOKEN}"