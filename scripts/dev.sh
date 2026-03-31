#!/usr/bin/env bash
# dev.sh — Local development environment for OpenClaw + Cloudflare Workers
#
# Spins up:
#   1. The OpenClaw container locally via Docker (port 18789 + 18790)
#   2. wrangler dev pointing at the local container
#
# Usage: ./scripts/dev.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'  GREEN='\033[0;32m'  YELLOW='\033[1;33m'  NC='\033[0m'
log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

CONTAINER_NAME="openclaw-dev"
OPENCLAW_DIR="${HOME}/.openclaw-dev"
WORKER_DIR="$(cd "$(dirname "$0")/../worker" && pwd)"

# ── 1. Build the container image locally ─────────────────────────────────────
log "Building OpenClaw container image for local dev"
docker build \
  -t openclaw-cf:dev \
  "$(dirname "$0")/../container"

# ── 2. Create local state directory ──────────────────────────────────────────
mkdir -p "${OPENCLAW_DIR}/workspace"

# ── 3. Stop existing dev container ───────────────────────────────────────────
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

# ── 4. Start the container ────────────────────────────────────────────────────
log "Starting OpenClaw container on :18789 (health on :18790)"
log "State directory: ${OPENCLAW_DIR}"

docker run -d \
  --name "${CONTAINER_NAME}" \
  -p 18789:18789 \
  -p 18790:18790 \
  -v "${OPENCLAW_DIR}:/home/node/.openclaw" \
  -e "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-devtoken}" \
  -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
  -e "CONTAINER_SHARD_ID=dev" \
  # In dev: skip R2 sync by pointing at a dummy bucket (rclone will fail gracefully)
  -e "R2_ACCESS_KEY_ID=dev" \
  -e "R2_SECRET_ACCESS_KEY=dev" \
  -e "CF_ACCOUNT_ID=dev" \
  -e "R2_BUCKET_NAME=openclaw-dev-local" \
  openclaw-cf:dev

log "Container started — waiting for health check"
for i in $(seq 1 20); do
  if curl -sf http://localhost:18790/health > /dev/null 2>&1; then
    log "Container healthy"
    break
  fi
  if [ "$i" -eq 20 ]; then
    warn "Container not ready after 20s — check logs: docker logs ${CONTAINER_NAME}"
    exit 1
  fi
  sleep 1
done

# ── 5. Create a .dev.vars file for wrangler ───────────────────────────────────
cat > "${WORKER_DIR}/.dev.vars" << EOF
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-devtoken}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
R2_ACCESS_KEY_ID=dev
R2_SECRET_ACCESS_KEY=dev
CF_ACCOUNT_ID=dev
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=dev
SLACK_SIGNING_SECRET=dev
SLACK_BOT_TOKEN=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
EOF

log "Wrote .dev.vars"

# ── 6. Print useful shortcuts ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Local dev environment ready${NC}"
echo ""
echo "  Container logs:  docker logs -f ${CONTAINER_NAME}"
echo "  Container shell: docker exec -it ${CONTAINER_NAME} bash"
echo "  Gateway UI:      http://localhost:18789/?token=${OPENCLAW_GATEWAY_TOKEN:-devtoken}"
echo "  Health check:    http://localhost:18790/health"
echo ""
echo "Starting wrangler dev..."
echo ""

# ── 7. Start wrangler dev ────────────────────────────────────────────────────
cd "${WORKER_DIR}"
npx wrangler dev --local
