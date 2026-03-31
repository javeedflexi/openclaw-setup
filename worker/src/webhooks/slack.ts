// webhooks/slack.ts
// Handles Slack Events API payloads, verifies HMAC-SHA256 signatures,
// and forwards to the correct OpenClaw container shard.
//
// Setup:
//   1. Create a Slack App → Event Subscriptions → set Request URL to
//      https://your-worker.dev/webhooks/slack
//   2. Subscribe to: message.channels, message.im, app_mention
//   3. Add SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN to wrangler secrets

import { resolveShardForUser } from '../lib/shard'
import { getContainer }        from '@cloudflare/containers'
import type { Env }            from '../worker'

// Minimal Slack event types
interface SlackEvent {
  type:     string
  user?:    string
  text?:    string
  channel?: string
  ts?:      string
}
interface SlackPayload {
  type:         string
  team_id?:     string
  event?:       SlackEvent
  challenge?:   string  // URL verification
  event_id?:    string
  event_time?:  number
}

export async function handleSlackWebhook(
  request: Request,
  env:     Env,
  ctx:     ExecutionContext,
): Promise<Response> {

  // ── 1. Read raw body (needed for HMAC verification) ───────────────────────
  const rawBody  = await request.text()

  // ── 2. Verify Slack signature ─────────────────────────────────────────────
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') ?? ''
  const signature = request.headers.get('X-Slack-Signature') ?? ''

  if (!await verifySlackSignature(rawBody, timestamp, signature, env.SLACK_SIGNING_SECRET)) {
    return new Response('Forbidden', { status: 403 })
  }

  // ── 3. Parse payload ──────────────────────────────────────────────────────
  let payload: SlackPayload
  try {
    payload = JSON.parse(rawBody) as SlackPayload
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // ── 4. Handle URL verification challenge (one-time Slack setup) ───────────
  if (payload.type === 'url_verification') {
    return Response.json({ challenge: payload.challenge })
  }

  // ── 5. Extract user from event ────────────────────────────────────────────
  const slackUserId = payload.event?.user
  if (!slackUserId || payload.type !== 'event_callback') {
    return new Response('OK')
  }

  const userId = `sl-${slackUserId}`

  // ── 6. Deduplicate (Slack retries on failure — use event_id as idempotency key) ─
  if (payload.event_id) {
    const dedupKey = `dedup:${payload.event_id}`
    const seen     = await env.ROUTING_KV.get(dedupKey)
    if (seen) return new Response('OK') // already processed
    ctx.waitUntil(env.ROUTING_KV.put(dedupKey, '1', { expirationTtl: 300 }))
  }

  // ── 7. Route to shard ─────────────────────────────────────────────────────
  const { shardKey } = await resolveShardForUser(userId, env.ROUTING_KV, ctx)
  const container    = getContainer(env.OPENCLAW, shardKey)

  const fwdRequest = new Request('http://container/webhooks/slack', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Bot-Token':       env.OPENCLAW_GATEWAY_TOKEN,
      'X-User-Id':         userId,
      'X-OpenClaw-Shard':  shardKey,
      'X-Slack-Bot-Token': env.SLACK_BOT_TOKEN,
    },
    body: rawBody,
  })

  // Respond to Slack immediately (must be < 3s), process async
  ctx.waitUntil(container.fetch(fwdRequest).catch(e =>
    console.error('[slack webhook] forward failed:', e)
  ))

  return new Response('OK', { status: 200 })
}

// ── HMAC-SHA256 signature verification ────────────────────────────────────────
async function verifySlackSignature(
  body:      string,
  timestamp: string,
  signature: string,
  secret:    string,
): Promise<boolean> {
  // Replay attack protection: reject requests older than 5 minutes
  const ts = parseInt(timestamp, 10)
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false

  const baseString = `v0:${timestamp}:${body}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString))
  const computed  = 'v0=' + Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Timing-safe compare
  if (computed.length !== signature.length) return false
  const a = new TextEncoder().encode(computed)
  const b = new TextEncoder().encode(signature)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
