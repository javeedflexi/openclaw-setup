#!/usr/bin/env bash
# deploy.sh — One-command deployment for OpenClaw on Cloudflare Containers
# Usage: ./deploy.sh [--preview]
# Prerequisites: wrangler installed, docker running, CF account on Workers Paid
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKER_DIR="$(cd "$(dirname "$0")/worker" && pwd)"
BOLD='\033[1m'  GREEN='\033[0;32m'  YELLOW='\033[1;33m'  RED='\033[0;31m'  NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}   $*"; }
err()  { echo -e "${RED}[error]${NC}  $*"; exit 1; }

# ── 0. Prereq checks ──────────────────────────────────────────────────────────
command -v wrangler &>/dev/null || err "wrangler not found. Run: npm i -g wrangler"
command -v docker   &>/dev/null || err "docker not found — required to build container image"
docker info &>/dev/null         || err "Docker daemon not running"

log "All prerequisites found"

cd "${WORKER_DIR}"

# ── 1. Install worker dependencies ───────────────────────────────────────────
log "Installing worker dependencies"
npm install --silent

# ── 2. Create KV namespace (idempotent — fails gracefully if exists) ─────────
log "Creating KV namespace (routing + rate-limits)"
KV_OUTPUT=$(wrangler kv namespace create ROUTING_KV 2>&1 || true)
KV_ID=$(echo "${KV_OUTPUT}" | grep -oP '"id": "\K[^"]+' | head -1 || true)

if [ -n "${KV_ID}" ]; then
  log "KV namespace created: ${KV_ID}"
  # Patch wrangler.jsonc with real IDs
  sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/${KV_ID}/g" wrangler.jsonc
  # Preview KV (for wrangler dev)
  KV_PREVIEW=$(wrangler kv namespace create ROUTING_KV --preview 2>&1 | grep -oP '"id": "\K[^"]+' | head -1 || echo "${KV_ID}")
  sed -i "s/REPLACE_WITH_PREVIEW_KV_ID/${KV_PREVIEW}/g" wrangler.jsonc
else
  warn "KV namespace may already exist — check wrangler.jsonc IDs"
fi

# ── 3. Create R2 bucket ──────────────────────────────────────────────────────
log "Creating R2 bucket: openclaw-sessions"
wrangler r2 bucket create openclaw-sessions 2>&1 || warn "Bucket may already exist"

# ── 4. Set secrets ────────────────────────────────────────────────────────────
log "Setting secrets (you'll be prompted for each value)"

set_secret() {
  local KEY="$1"
  local DEFAULT="${2:-}"
  if [ -n "${DEFAULT}" ]; then
    echo "${DEFAULT}" | wrangler secret put "${KEY}" --no-interactive 2>&1 || true
  else
    echo -e "${BOLD}Enter value for secret ${KEY}:${NC}"
    wrangler secret put "${KEY}"
  fi
}

# Gateway token — auto-generate if not set
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
  warn "Generated gateway token: ${OPENCLAW_GATEWAY_TOKEN}"
  warn "Save this — you need it to access the control UI"
fi
set_secret OPENCLAW_GATEWAY_TOKEN "${OPENCLAW_GATEWAY_TOKEN}"

# These require real values from the operator
[ -z "${ANTHROPIC_API_KEY:-}" ]     && read -rp "ANTHROPIC_API_KEY: "     ANTHROPIC_API_KEY
[ -z "${R2_ACCESS_KEY_ID:-}" ]      && read -rp "R2_ACCESS_KEY_ID: "      R2_ACCESS_KEY_ID
[ -z "${R2_SECRET_ACCESS_KEY:-}" ]  && read -rp "R2_SECRET_ACCESS_KEY: "  R2_SECRET_ACCESS_KEY
[ -z "${CF_ACCOUNT_ID:-}" ]         && read -rp "CF_ACCOUNT_ID: "         CF_ACCOUNT_ID

set_secret ANTHROPIC_API_KEY    "${ANTHROPIC_API_KEY}"
set_secret R2_ACCESS_KEY_ID     "${R2_ACCESS_KEY_ID}"
set_secret R2_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY}"
set_secret CF_ACCOUNT_ID        "${CF_ACCOUNT_ID}"

# ── 5. Deploy (builds docker image + deploys worker in one command) ───────────
log "Deploying Worker + Container image via wrangler deploy"
log "This builds your Dockerfile and pushes it to registry.cloudflare.com"
log "(Requires Docker to be running)"

if [[ "${1:-}" == "--preview" ]]; then
  wrangler versions upload
else
  wrangler deploy
fi

log ""
log "────────────────────────────────────────────────────"
log "Deployment complete!"
log ""
log "Gateway token: ${OPENCLAW_GATEWAY_TOKEN}"
log "Control UI:    https://openclaw-gateway.<your-subdomain>.workers.dev/"
log ""
log "Useful commands:"
log "  wrangler tail              — live logs"
log "  wrangler containers ssh    — SSH into a container"
log "  wrangler secret list       — list secrets"
log "────────────────────────────────────────────────────"
