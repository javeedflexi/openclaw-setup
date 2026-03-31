# OpenClaw on Cloudflare Containers

Run OpenClaw Gateway as sharded Cloudflare Containers, fronted by a Worker that handles auth, sticky routing, rate limiting, and WebSocket proxying.

## Architecture

```
User (Telegram / Slack / WebChat / REST)
        │ HTTPS / WSS
        ▼
┌─────────────────────────────────────────────────────────────┐
│               Cloudflare Worker  (worker.ts)                 │
│                                                             │
│  1. Authenticate   Bearer token / X-Bot-Token header        │
│  2. Rate limit     60 req/min per user  (KV token bucket)   │
│  3. Route          userId → shardId via SHA-256 hash + KV   │
│  4. Proxy          HTTP + WebSocket → OpenClawContainer DO  │
└───────────────────────────┬─────────────────────────────────┘
                            │  Durable Object binding
          ┌─────────────────┼──────────────────────┐
          │ shard-0         │ shard-1       shard-N │
          ▼                 ▼                       ▼
  ┌───────────────┐ ┌───────────────┐     ┌──────────────┐
  │  CF Container │ │  CF Container │ ... │  CF Container│
  │  OpenClaw GW  │ │  OpenClaw GW  │     │  OpenClaw GW │
  │  port 18789   │ │  port 18789   │     │  port 18789  │
  │               │ │               │     │              │
  │  health.js    │ │  health.js    │     │  health.js   │
  │  port 18790   │ │  port 18790   │     │  port 18790  │
  └───────┬───────┘ └───────────────┘     └──────────────┘
          │  rclone on start/stop/every-5-min
          ▼
  ┌───────────────────────────────────────────────────────┐
  │        Cloudflare R2   (openclaw-sessions)            │
  │  shards/shard-0/  — sessions, memory, workspace       │
  │  shards/shard-1/  — ...                               │
  └───────────────────────────────────────────────────────┘
          │
          ▼
  ┌──────────────────────────────────────────────────────┐
  │      Cloudflare KV  (ROUTING_KV)                     │
  │  shard:<userId>     → shardId   (TTL 1h)             │
  │  rl:<userId>:<min>  → count     (TTL 2min)           │
  └──────────────────────────────────────────────────────┘

  LLM calls leave the container → Anthropic / OpenAI API
```

## Project Structure

```
openclaw-cf/
├── container/
│   ├── Dockerfile              # Wraps ghcr.io/openclaw/openclaw:latest
│   └── scripts/
│       ├── entrypoint.sh       # Start: R2 restore → gateway → periodic sync
│       ├── sync.sh             # rclone push helper
│       └── health.js           # Health server on :18790
├── worker/
│   ├── wrangler.jsonc          # Worker + Container + KV + R2 config
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── worker.ts           # Worker + OpenClawContainer Durable Object
├── deploy.sh                   # One-command deploy
└── README.md
```

## Prerequisites

- Cloudflare account on **Workers Paid** plan ($5/month)
- `wrangler` CLI: `npm install -g wrangler`
- Docker Desktop running locally (for image build)
- R2 API token with read+write on `openclaw-sessions` bucket
- An API key for your LLM provider (Anthropic, OpenAI, etc.)

## Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

The script:
1. Creates the KV namespace and R2 bucket
2. Sets all secrets via `wrangler secret put`
3. Runs `wrangler deploy` which builds your Dockerfile and deploys everything

## Set Secrets Manually

```bash
wrangler secret put OPENCLAW_GATEWAY_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CF_ACCOUNT_ID
```

## Scale Shards

Edit `NUM_SHARDS` in `worker.ts` and `max_instances` in `wrangler.jsonc`.

Rule of thumb: 1 container handles ~300–500 concurrent active sessions.
- 6K users at 15% concurrency = ~900 active → 3 shards minimum, 6 recommended.

## Connecting Channels

After deploy, SSH into a container and run the channel login commands:

```bash
# SSH into shard 0
wrangler containers ssh --instance shard-0

# Inside the container:
openclaw channels add --channel telegram --token "<your-token>"
openclaw channels add --channel discord --token "<your-token>"
# WhatsApp: requires QR scan — use the WebChat UI instead
```

## Access the Control UI

Open `https://openclaw-gateway.<subdomain>.workers.dev/` in your browser.
Paste your `OPENCLAW_GATEWAY_TOKEN` when prompted.

## Known Limitations (Cloudflare Containers Beta)

| Issue | Workaround |
|-------|-----------|
| Disk is ephemeral | entrypoint.sh syncs to/from R2 on every start/stop |
| No native autoscaling | Increase `max_instances` in wrangler.jsonc manually |
| WS keepalive bug (#147) | Client should send HTTP keepalive to /health every 5 min |
| DO + Container not always co-located | `"placement": { "mode": "smart" }` helps |
| Cold starts 2–3s | `sleepAfter = '60m'` keeps active shards warm |

## Cost Estimate (6K users)

| Resource | Usage | Est. Cost |
|----------|-------|-----------|
| Workers Paid | base | $5/mo |
| CF Containers standard-1 | 6 instances × 60 min/user/day × 6K users | ~$15–40/mo |
| R2 storage | 6K × ~5 MB state | ~$0.05/mo |
| R2 operations | syncs every 5 min per active session | ~$1/mo |
| KV reads | auth + routing | ~$0.50/mo |
| **Total** | | **~$22–47/mo** |

vs. EC2 t3.medium × 3 = ~$75/mo + data transfer.
