// worker.ts — OpenClaw Gateway Worker
import { Container, getContainer } from '@cloudflare/containers'
import { resolveShardForUser, checkRateLimit } from './lib/shard'
import { authenticate, unauthorizedResponse } from './lib/auth'
import { handleTelegramWebhook } from './webhooks/telegram'
import { handleSlackWebhook } from './webhooks/slack'
import { handleDiscordWebhook } from './webhooks/discord'
import { handleAdmin } from './admin/routes'

export interface Env {
  OPENCLAW: DurableObjectNamespace
  ROUTING_KV: KVNamespace
  STATE_BUCKET: R2Bucket

  OPENCLAW_GATEWAY_TOKEN: string
  ANTHROPIC_API_KEY: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  CF_ACCOUNT_ID: string
  OPENCLAW_WORKER_URL: string

  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  SLACK_SIGNING_SECRET: string
  SLACK_BOT_TOKEN: string
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const isWS = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (path === '/health') {
      return withCors(Response.json({ ok: true, ts: Date.now() }))
    }

    // Pass Control UI through without auth — it handles its own WS auth
    // Matches: /, /index.html, /__openclaw__/*, /assets/*, static files
    const isControlUI = path === '/'
      || path === '/index.html'
      || path.startsWith('/__openclaw__/')
      || path.startsWith('/assets/')
      || path.startsWith('/static/')
      || path.endsWith('.js')
      || path.endsWith('.css')
      || path.endsWith('.ico')
      || path.endsWith('.png')
      || path.endsWith('.svg')
      || path.endsWith('.woff2')

    if (isControlUI) {
      const containerId = 'c1' // Control UI always goes to first container
      const stub = env.OPENCLAW.get(env.OPENCLAW.idFromName(containerId)) as any
      return stub.fetch(new Request(
        `http://container${path}${url.search}`,
        { method: request.method, headers: request.headers, body: request.body }
      ))
    }

    if (path === '/webhooks/telegram') return withCors(await handleTelegramWebhook(request, env, ctx))
    if (path === '/webhooks/slack') return withCors(await handleSlackWebhook(request, env, ctx))
    if (path === '/webhooks/discord') return withCors(await handleDiscordWebhook(request, env, ctx))

    if (path.startsWith('/admin')) {
      const auth = authenticate(request, env.OPENCLAW_GATEWAY_TOKEN)
      if (!auth.ok) return withCors(unauthorizedResponse(auth.reason))
      return withCors(await handleAdmin(request, env, ctx))
    }

    // WebSocket
    if (isWS || path === '/ws') {
      const tokenQ = url.searchParams.get('token') ?? ''
      const tokenH = (request.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const token = tokenQ || tokenH
      if (!token || token !== env.OPENCLAW_GATEWAY_TOKEN) {
        return new Response('Unauthorized', { status: 401 })
      }
      const userId = url.searchParams.get('userId') ?? `u-${token.slice(0, 16)}`
      const { shardKey } = await resolveShardForUser(userId, env.ROUTING_KV, ctx)
      const container = getContainer(env.OPENCLAW, shardKey)
      return container.fetch(new Request(
        `http://container/ws${url.search}`,
        { headers: forwardHeaders(request.headers, userId, shardKey) }
      ))
    }

    // HTTP
    const auth = authenticate(request, env.OPENCLAW_GATEWAY_TOKEN)
    if (!auth.ok) return withCors(unauthorizedResponse(auth.reason))
    const { userId } = auth

    const rl = await checkRateLimit(userId, env.ROUTING_KV, ctx)
    if (!rl.allowed) {
      return withCors(new Response(
        JSON.stringify({ error: 'rate_limit_exceeded' }),
        { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'application/json' } }
      ))
    }

    const { shardKey } = await resolveShardForUser(userId, env.ROUTING_KV, ctx)
    const container = getContainer(env.OPENCLAW, shardKey)
    return withCors(await container.fetch(new Request(
      `http://container${path.replace(/^\/api/, '') || '/'}${url.search}`,
      { method: request.method, headers: forwardHeaders(request.headers, userId, shardKey), body: request.body }
    )))
  }
}

// ── OpenClawContainer ─────────────────────────────────────────────────────────
// envVars are injected at deploy time — Cloudflare passes these to the
// container process at startup automatically. No startAndWaitForPorts needed.
export class OpenClawContainer extends Container {
  defaultPort = 18789
  sleepAfter = '60m'
  enableInternet = true

  override onStart() { console.log('[Container] started') }
  override onStop() { console.log('[Container] stopped') }
  override onError(e: unknown) { console.error('[Container] error:', e); throw e }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function forwardHeaders(original: Headers, userId: string, shard: string): Headers {
  const h = new Headers(original)
  h.set('X-OpenClaw-User', userId)
  h.set('X-OpenClaw-Shard', shard)
  h.delete('Authorization')
  return h
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bot-Token, X-User-Id',
  }
}

function withCors(r: Response): Response {
  const res = new Response(r.body, r)
  Object.entries(corsHeaders()).forEach(([k, v]) => res.headers.set(k, v))
  return res
}
