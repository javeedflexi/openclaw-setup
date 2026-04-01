// worker.ts — OpenClaw Gateway Worker with R2 state persistence
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

      // R2 state save — called by container on SIGTERM
      if (path === '/admin/r2/save') {
        const shard = url.searchParams.get('shard') ?? 'c1'
        const body = await request.arrayBuffer()
        if (body.byteLength === 0) {
          return withCors(Response.json({ ok: false, error: 'empty body' }, { status: 400 }))
        }
        await env.STATE_BUCKET.put(
          `state/${shard}/state.tar.gz`,
          body,
          { httpMetadata: { contentType: 'application/gzip' } }
        )
        console.log(`[R2] Saved state for shard ${shard}: ${body.byteLength} bytes`)
        return withCors(Response.json({ ok: true, shard, bytes: body.byteLength }))
      }

      // R2 state restore — called by container on startup
      if (path === '/admin/r2/restore') {
        const shard = url.searchParams.get('shard') ?? 'c1'
        const object = await env.STATE_BUCKET.get(`state/${shard}/state.tar.gz`)
        if (!object) {
          console.log(`[R2] No state found for shard ${shard}`)
          return new Response(null, { status: 404 })
        }
        console.log(`[R2] Restoring state for shard ${shard}`)
        return new Response(object.body, {
          headers: { 'Content-Type': 'application/gzip' }
        })
      }

      // R2 state delete — manual reset
      if (path === '/admin/r2/delete') {
        const shard = url.searchParams.get('shard') ?? 'c1'
        await env.STATE_BUCKET.delete(`state/${shard}/state.tar.gz`)
        return withCors(Response.json({ ok: true, shard, deleted: true }))
      }

      // R2 state list — show all saved shards
      if (path === '/admin/r2/list') {
        const list = await env.STATE_BUCKET.list({ prefix: 'state/' })
        return withCors(Response.json({
          ok: true, objects: list.objects.map(o => ({
            key: o.key, size: o.size, uploaded: o.uploaded
          }))
        }))
      }

      return withCors(await handleAdmin(request, env, ctx))
    }

    // ── WebSocket — proxy straight through to container ───────────────────────
    // Control UI handles its own auth over the WebSocket protocol.
    // Must use getContainer() not env.OPENCLAW.get() for WS upgrade support.
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
export class OpenClawContainer extends Container {
  defaultPort = 18789
  sleepAfter = '4h'
  enableInternet = true

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
  h.set('X-Worker-Url', 'https://openclaw-gateway.techadmin-ad6.workers.dev')
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
