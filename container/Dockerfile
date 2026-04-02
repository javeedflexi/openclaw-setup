FROM ghcr.io/openclaw/openclaw:latest

USER root
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends curl ca-certificates unzip && \
  curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && \
  unzip -q /tmp/rclone.zip -d /tmp && \
  mv /tmp/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && \
  chmod 755 /usr/local/bin/rclone && \
  rm -rf /tmp/rclone* && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/node
ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
ENV TERM=xterm-256color
# Non-secret defaults — real values are injected at runtime via Worker envVars
ENV OPENCLAW_WORKER_URL=https://openclaw-gateway.techadmin-ad6.workers.dev

# OPENCLAW_GATEWAY_TOKEN, ANTHROPIC_API_KEY, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, R2_BUCKET_NAME are NOT hardcoded here.
# They are passed from Worker secrets via OpenClawContainer.envVars at startup.

COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh && \
  chown node:node /start.sh

EXPOSE 18789

HEALTHCHECK --interval=20s --timeout=10s --start-period=120s --retries=6 \
  CMD curl -sf http://localhost:18789/healthz || exit 1

USER node

CMD ["/bin/sh", "/start.sh"]
