// webhooks/discord.ts
// Discord Interactions endpoint — slash commands and message events.
// Uses Ed25519 signature verification (required by Discord).
//
// Setup:
//   1. Discord Developer Portal → App → Interactions Endpoint URL →
//      https://your-worker.dev/webhooks/discord
//   2. Add DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN to wrangler secrets

import { resolveShardForUser } from '../lib/shard'
import { getContainer }        from '@cloudflare/containers'
import type { Env }            from '../worker'

interface DiscordInteraction {
  type:        number   // 1=Ping, 2=ApplicationCommand, 3=MessageComponent
  id:          string
  application_id: string
  data?:       { name?: string; options?: Array<{ name: string; value: string }> }
  member?:     { user: { id: string; username: string } }
  user?:       { id: string; username: string }
  token:       string
  channel_id?: string
  guild_id?:   string
}

export async function handleDiscordWebhook(
  request: Request,
  env:     Env,
  ctx:     ExecutionContext,
): Promise<Response> {

  // ── 1. Verify Ed25519 signature (Discord requires this — 401 = unverified) ─
  const signature = request.headers.get('X-Signature-Ed25519')    ?? ''
  const timestamp = request.headers.get('X-Signature-Timestamp')  ?? ''
  const rawBody   = await request.text()

  if (!await verifyDiscordSignature(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY)) {
    return new Response('Invalid request signature', { status: 401 })
  }

  // ── 2. Parse interaction ──────────────────────────────────────────────────
  let interaction: DiscordInteraction
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // ── 3. Handle ping (Discord health check) ────────────────────────────────
  if (interaction.type === 1) {
    return Response.json({ type: 1 }) // PONG
  }

  // ── 4. Extract Discord user ───────────────────────────────────────────────
  const discordUserId =
    interaction.member?.user?.id ??
    interaction.user?.id ??
    null

  if (!discordUserId) {
    return Response.json({ type: 4, data: { content: 'Could not identify user.' } })
  }

  const userId = `dc-${discordUserId}`

  // ── 5. Route to shard and forward ────────────────────────────────────────
  const { shardKey } = await resolveShardForUser(userId, env.ROUTING_KV, ctx)
  const container    = getContainer(env.OPENCLAW, shardKey)

  const fwdRequest = new Request('http://container/webhooks/discord', {
    method:  'POST',
    headers: {
      'Content-Type':        'application/json',
      'X-Bot-Token':         env.OPENCLAW_GATEWAY_TOKEN,
      'X-User-Id':           userId,
      'X-OpenClaw-Shard':    shardKey,
      'X-Discord-Bot-Token': env.DISCORD_BOT_TOKEN,
    },
    body: rawBody,
  })

  // Discord expects a response within 3s — acknowledge immediately,
  // then send a follow-up via the interaction token
  ctx.waitUntil(container.fetch(fwdRequest).catch(e =>
    console.error('[discord webhook] forward failed:', e)
  ))

  // Deferred channel message — OpenClaw will follow up via interaction token
  return Response.json({
    type: 5,  // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: { flags: 0 }
  })
}

// ── Ed25519 signature verification ────────────────────────────────────────────
async function verifyDiscordSignature(
  body:      string,
  signature: string,
  timestamp: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const keyBytes = hexToBytes(publicKey)
    const sigBytes = hexToBytes(signature)
    const msgBytes = new TextEncoder().encode(timestamp + body)

    const key = await crypto.subtle.importKey(
      'raw', keyBytes,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false, ['verify']
    )
    return crypto.subtle.verify('NODE-ED25519', key, sigBytes, msgBytes)
  } catch {
    return false
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}
