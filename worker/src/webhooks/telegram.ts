// webhooks/telegram.ts
// Handles Telegram Bot API webhooks and forwards messages to the correct
// OpenClaw container shard via the internal routing layer.
//
// Setup:
//   1. Create a bot via @BotFather → get TELEGRAM_BOT_TOKEN
//   2. Register webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.dev/webhooks/telegram
//   3. Add TELEGRAM_BOT_TOKEN to wrangler secrets

import { getContainer } from '@cloudflare/containers'
import { pickContainer } from '../worker'
import type { Env } from '../worker'

// Telegram Update object (minimal typing — add fields as needed)
interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string; first_name?: string }
    chat: { id: number; type: string }
    text?: string
    photo?: Array<{ file_id: string }>
    document?: { file_id: string; file_name?: string }
    date: number
  }
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
  }
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {

  // ── 1. Validate Telegram secret token (set via setWebhook?secret_token=...) ─
  const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (!secretToken || secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 })
  }

  // ── 2. Parse update ───────────────────────────────────────────────────────
  let update: TelegramUpdate
  try {
    update = await request.json() as TelegramUpdate
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const msg = update.message
  const cbQuery = update.callback_query

  // Determine the Telegram user ID
  const telegramUserId =
    msg?.from?.id ??
    cbQuery?.from?.id ??
    null

  if (telegramUserId === null) {
    // Ignore unsupported update types silently
    return new Response('OK')
  }

  // Namespace the userId so Telegram and Slack users don't collide in routing
  const userId = `tg-${telegramUserId}`

  // ── 3. Resolve container (use same logic as HTTP API) ─────────────────────
  // This ensures Telegram messages route to the same container as the saved R2 state
  const shardKey = pickContainer(userId)  // Returns 'c1', 'c2', or 'c3'

  // ── 4. Forward to OpenClaw container ─────────────────────────────────────
  const container = getContainer(env.OPENCLAW, shardKey)

  // Reconstruct a clean request to the OpenClaw gateway webhook endpoint
  const gatewayUrl = `http://container/webhooks/telegram`
  const fwdRequest = new Request(gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Token': env.OPENCLAW_GATEWAY_TOKEN,
      'X-User-Id': userId,
      'X-OpenClaw-Shard': shardKey,
      'X-Telegram-Bot-Token': env.TELEGRAM_BOT_TOKEN,
    },
    body: JSON.stringify(update),
  })

  // Fire-and-forget — Telegram expects 200 within 5s; we respond immediately
  // and let the container process asynchronously
  ctx.waitUntil(container.fetch(fwdRequest).catch(e =>
    console.error('[telegram webhook] forward failed:', e)
  ))

  // Always return 200 immediately to Telegram to prevent retries
  return new Response('OK', { status: 200 })
}

// ── Register the Telegram webhook URL with Telegram's API ────────────────────
// Call this once after deploy: GET /admin/register-telegram-webhook
export async function registerTelegramWebhook(
  workerUrl: string,
  botToken: string,
  secret: string,
): Promise<{ ok: boolean; description?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${workerUrl}/webhooks/telegram`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query', 'inline_query'],
      max_connections: 100,
    }),
  })
  return res.json() as Promise<{ ok: boolean; description?: string }>
}