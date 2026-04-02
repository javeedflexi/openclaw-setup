// worker.ts — OpenClaw Gateway Worker
// R2 persistence uses rclone inside the container (same as moltbot-sandbox).
// The Worker passes R2 credentials to the container via this.envVars in the
// OpenClawContainer constructor — the container then syncs directly to R2
// using the S3-compatible API, with no HTTP round-trip through the Worker.
import { Container, getContainer } from '@cloudflare/containers'
import { checkRateLimit } from './lib/shard'
import { authenticate, unauthorizedResponse } from './lib/auth'
import { handleTelegramWebhook } from './webhooks/telegram'
import { handleSlackWebhook } from './webhooks/slack'
import { handleDiscordWebhook } from './webhooks/discord'
import { handleAdmin } from './admin/routes'

export interface Env {
  OPENCLAW: DurableObjectNamespace
  ROUTING_KV: KVNamespace
  STATE_BUCKET: R2Bucket
  // Worker secrets — set via `wrangler secret put`
  OPENCLAW_GATEWAY_TOKEN: string
  ANTHROPIC_API_KEY: string
  OPENCLAW_WORKER_URL: string
  // R2 credentials forwarded to the container for direct rclone access
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  CF_ACCOUNT_ID: string
  R2_BUCKET_NAME?: string          // defaults to 'openclaw-sessions'
  // Chat channel tokens
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  SLACK_SIGNING_SECRET: string
  SLACK_BOT_TOKEN: string
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
}

// ── Container pool ────────────────────────────────────────────────────────────
const CONTAINERS = ['c1', 'c2', 'c3']

export function pickContainer(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i)
    hash |= 0
  }
  return CONTAINERS[Math.abs(hash) % CONTAINERS.length]
}

// ── Control UI static paths ───────────────────────────────────────────────────
function isStaticAsset(path: string): boolean {
  return path === '/'
    || path === '/index.html'
    || path.startsWith('/__openclaw__/')
    || path.startsWith('/assets/')
    || path.startsWith('/static/')
    || path.startsWith('/chat')
    || path.startsWith('/overview')
    || path.startsWith('/channels')
    || path.startsWith('/sessions')
    || path.endsWith('.js')
    || path.endsWith('.css')
    || path.endsWith('.ico')
    || path.endsWith('.png')
    || path.endsWith('.svg')
    || path.endsWith('.woff2')
    || path.endsWith('.woff')
    || path.endsWith('.ttf')
    || path.endsWith('.map')
}

// ── Worker ────────────────────────────────────────────────────────────────────
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

    // ── Control UI static files — no auth, always route to c1 ────────────────
    if (isStaticAsset(path)) {
      const stub = env.OPENCLAW.get(env.OPENCLAW.idFromName('c1')) as any
      return stub.fetch(new Request(
        `http://container${path}${url.search}`,
        { method: request.method, headers: request.headers, body: request.body }
      ))
    }

    // ── Webhooks ──────────────────────────────────────────────────────────────
    if (path === '/webhooks/telegram') return withCors(await handleTelegramWebhook(request, env, ctx))
    if (path === '/webhooks/slack') return withCors(await handleSlackWebhook(request, env, ctx))
    if (path === '/webhooks/discord') return withCors(await handleDiscordWebhook(request, env, ctx))

    // ── Admin routes — Bearer required ────────────────────────────────────────
    if (path.startsWith('/admin')) {
      const auth = authenticate(request, env.OPENCLAW_GATEWAY_TOKEN)
      if (!auth.ok) return withCors(unauthorizedResponse(auth.reason))

      // R2 state list — show all saved shards (uses Worker-side STATE_BUCKET binding)
      if (path === '/admin/r2/list') {
        const list = await env.STATE_BUCKET.list({ prefix: 'state/' })
        return withCors(Response.json({
          ok: true, objects: list.objects.map(o => ({
            key: o.key, size: o.size, uploaded: o.uploaded
          }))
        }))
      }

      // R2 state delete — manual reset for a shard
      if (path === '/admin/r2/delete') {
        const shard = url.searchParams.get('shard') ?? 'c1'
        // Delete all objects under state/<shard>/
        const list = await env.STATE_BUCKET.list({ prefix: `state/${shard}/` })
        await Promise.all(list.objects.map(o => env.STATE_BUCKET.delete(o.key)))
        return withCors(Response.json({ ok: true, shard, deleted: list.objects.length }))
      }

      return withCors(await handleAdmin(request, env, ctx))
    }

    // ── WebSocket — proxy straight through to container ───────────────────────
    if (isWS) {
      const container = getContainer(env.OPENCLAW, 'c1')
      return container.fetch(new Request(
        `http://container${path}${url.search}`,
        { headers: request.headers }
      ))
    }

    // ── HTTP routes — auth + rate-limit + proxy ───────────────────────────────
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

    const containerId = pickContainer(userId)
    const container = getContainer(env.OPENCLAW, containerId)

    return withCors(await container.fetch(new Request(
      `http://container${path.replace(/^\/api/, '') || '/'}${url.search}`,
      { method: request.method, headers: fwdHeaders(request.headers, userId, containerId), body: request.body }
    )))
  }
}

// ── OpenClawContainer ─────────────────────────────────────────────────────────
// Mirrors moltbot-sandbox's buildEnvVars() pattern: Worker secrets are passed
// into the container process via this.envVars so the container can configure
// rclone and sync directly to R2 without routing through the Worker.
export class OpenClawContainer extends Container {
  defaultPort = 18789
  sleepAfter = '4h'
  enableInternet = true

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    const vars: Record<string, string> = {}

    if (env.ANTHROPIC_API_KEY)    vars.ANTHROPIC_API_KEY    = env.ANTHROPIC_API_KEY
    if (env.OPENCLAW_GATEWAY_TOKEN) vars.OPENCLAW_GATEWAY_TOKEN = env.OPENCLAW_GATEWAY_TOKEN
    if (env.OPENCLAW_WORKER_URL)  vars.OPENCLAW_WORKER_URL  = env.OPENCLAW_WORKER_URL

    // R2 credentials for rclone — same secrets as moltbot uses
    if (env.R2_ACCESS_KEY_ID)     vars.R2_ACCESS_KEY_ID     = env.R2_ACCESS_KEY_ID
    if (env.R2_SECRET_ACCESS_KEY) vars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY
    if (env.CF_ACCOUNT_ID)        vars.CF_ACCOUNT_ID        = env.CF_ACCOUNT_ID
    vars.R2_BUCKET_NAME = env.R2_BUCKET_NAME ?? 'openclaw-sessions'

    // Tell the container which shard it is so rclone uses the right R2 path
    vars.CONTAINER_SHARD_ID = ctx.id.name ?? 'c1'

    this.envVars = vars
  }

  override onStart() { console.log('[Container] started') }
  override onStop() { console.log('[Container] stopped') }
  override onError(e: unknown) { console.error('[Container] error:', e); throw e }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fwdHeaders(original: Headers, userId: string, shard: string): Headers {
  const h = new Headers(original)
  h.set('X-OpenClaw-User', userId)
  h.set('X-OpenClaw-Shard', shard)
  h.set('X-Container-Shard-Id', shard)
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
