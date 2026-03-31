#!/usr/bin/env bash
# setup-channels.sh — Connect OpenClaw channels after deploy
# Run this once after `./deploy.sh` completes.
# Channels are registered on shard-0 by default (they receive messages
# from all shards via the multi-instance routing in OpenClaw 2.x).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'  GREEN='\033[0;32m'  CYAN='\033[0;36m'  YELLOW='\033[1;33m'  NC='\033[0m'
log()  { echo -e "${GREEN}►${NC} $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }

echo -e "\n${BOLD}OpenClaw Channel Setup${NC}\n"

# ── 1. Read worker URL ────────────────────────────────────────────────────────
read -rp "Your worker URL (e.g. https://openclaw-gateway.xxx.workers.dev): " WORKER_URL
read -rp "Gateway token: " GATEWAY_TOKEN
SHARD_ID=0

log "Using shard-${SHARD_ID} for channel registration"
info "Channels registered on one shard are accessible from all shards via R2 state"

# ── Helper: call admin API ─────────────────────────────────────────────────────
admin_post() {
  local path="$1"
  local body="$2"
  curl -sf \
    -X POST \
    -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}" \
    "${WORKER_URL}/admin/${path}"
}

# ── 2. Telegram ───────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Telegram${NC}"
info "1. Chat with @BotFather on Telegram"
info "2. /newbot → follow prompts → copy the bot token"
read -rp "Telegram bot token (leave blank to skip): " TG_TOKEN

if [ -n "${TG_TOKEN}" ]; then
  # Register webhook via admin API
  log "Registering Telegram webhook"
  result=$(admin_post "register-telegram" "{\"workerUrl\": \"${WORKER_URL}\"}" 2>&1 || true)
  echo "  Telegram result: ${result}"

  # Store token as wrangler secret
  echo "${TG_TOKEN}" | wrangler secret put TELEGRAM_BOT_TOKEN --no-interactive 2>/dev/null || true

  # Generate a webhook secret and store it
  TG_SECRET=$(openssl rand -hex 24)
  echo "${TG_SECRET}" | wrangler secret put TELEGRAM_WEBHOOK_SECRET --no-interactive 2>/dev/null || true

  log "Telegram configured — start chatting with your bot"
fi

# ── 3. Slack ──────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Slack${NC}"
info "1. Create a Slack App at api.slack.com/apps"
info "2. Event Subscriptions → set Request URL to: ${WORKER_URL}/webhooks/slack"
info "3. Subscribe to: message.channels, message.im, app_mention"
info "4. Copy Signing Secret + Bot User OAuth Token"
read -rp "Slack signing secret (leave blank to skip): " SLACK_SECRET
read -rp "Slack bot token (xoxb-...): " SLACK_TOKEN

if [ -n "${SLACK_SECRET}" ] && [ -n "${SLACK_TOKEN}" ]; then
  echo "${SLACK_SECRET}" | wrangler secret put SLACK_SIGNING_SECRET --no-interactive 2>/dev/null || true
  echo "${SLACK_TOKEN}"  | wrangler secret put SLACK_BOT_TOKEN --no-interactive 2>/dev/null || true
  log "Slack secrets stored — set the Events URL in your Slack app dashboard"
fi

# ── 4. Discord ────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Discord${NC}"
info "1. Discord Developer Portal → Your App → General Information"
info "2. Set Interactions Endpoint URL to: ${WORKER_URL}/webhooks/discord"
info "3. Copy App Public Key + Bot Token"
read -rp "Discord app public key (leave blank to skip): " DC_PUBKEY
read -rp "Discord bot token: " DC_TOKEN

if [ -n "${DC_PUBKEY}" ] && [ -n "${DC_TOKEN}" ]; then
  echo "${DC_PUBKEY}" | wrangler secret put DISCORD_PUBLIC_KEY --no-interactive 2>/dev/null || true
  echo "${DC_TOKEN}"  | wrangler secret put DISCORD_BOT_TOKEN  --no-interactive 2>/dev/null || true
  log "Discord secrets stored — redeploy to activate: wrangler deploy"
fi

# ── 5. WhatsApp (requires QR scan — must SSH into container) ──────────────────
echo -e "\n${BOLD}WhatsApp${NC}"
warn "WhatsApp requires a QR code scan — do this via SSH into the container"
info "After deploy: wrangler containers ssh --instance shard-0"
info "Then inside container: openclaw channels add --channel whatsapp"
info "Scan the QR code with your WhatsApp mobile app"

# ── Done ──────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}Channel setup complete!${NC}"
echo ""
echo "Control UI:  ${WORKER_URL}/"
echo "WebChat:     open webchat/index.html in your browser"
echo "Admin API:   curl -H 'Authorization: Bearer ${GATEWAY_TOKEN}' ${WORKER_URL}/admin/shards"
echo ""
echo "Remember to redeploy after adding secrets: wrangler deploy"
