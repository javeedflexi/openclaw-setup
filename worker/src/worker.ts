// worker.ts — OpenClaw Gateway Worker (3 container architecture)

import { Container } from '@cloudflare/containers'
import { checkRateLimit } from './lib/shard'
import { authenticate, unauthorizedResponse } from './lib/auth'
import { handleTelegramWebhook } from './webhooks/telegram'
import { handleSlackWebhook } from './webhooks/slack'
import { handleDiscordWebhook } from './webhooks/discord'
import { handleAdmin } from './admin/routes'

export interface Env {
  OPENCLAW: DurableObjectNamespace
  STATE_BUCKET: R2Bucket

  OPENCLAW_GATEWAY_TOKEN: string
  ANTHROPIC_API_KEY: string
  OPENCLAW_WORKER_URL: string

  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  SLACK_SIGNING_SECRET: string
  SLACK_BOT_TOKEN: string
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
}

//
// ─────────────────────────────────────────────────────────
// Container Pool (3 containers)
// ─────────────────────────────────────────────────────────
//

const CONTAINERS = ["c1", "c2", "c3"]

function pickContainer(userId: string) {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i)
    hash |= 0
  }

  return CONTAINERS[Math.abs(hash) % CONTAINERS.length]
}

//
// ─────────────────────────────────────────────────────────
// Worker fetch handler
// ─────────────────────────────────────────────────────────
//

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

    //
    // Webhooks
    //

    if (path === '/webhooks/telegram') {
      return withCors(await handleTelegramWebhook(request, env, ctx))
    }

    if (path === '/webhooks/slack') {
      return withCors(await handleSlackWebhook(request, env, ctx))
    }

    if (path === '/webhooks/discord') {
      return withCors(await handleDiscordWebhook(request, env, ctx))
    }

    //
    // Admin routes
    //

    if (path.startsWith('/admin')) {
      const auth = authenticate(request, env.OPENCLAW_GATEWAY_TOKEN)

      if (!auth.ok) {
        return withCors(unauthorizedResponse(auth.reason))
      }

      return withCors(await handleAdmin(request, env, ctx))
    }

    //
    // WebSocket connections
    //

    if (isWS || path === '/ws') {

      const tokenFromQuery = url.searchParams.get('token') ?? ''
      const tokenFromHeader = (request.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const token = tokenFromQuery || tokenFromHeader

      if (!token || token !== env.OPENCLAW_GATEWAY_TOKEN) {
        return new Response('Unauthorized', { status: 401 })
      }

      const userId = url.searchParams.get('userId') ?? `u-${token.slice(0, 16)}`
      const containerId = pickContainer(userId)

      const stub = env.OPENCLAW.get(
        env.OPENCLAW.idFromName(containerId)
      ) as unknown as OpenClawContainer

      const wsReq = new Request(`http://container/ws${url.search}`, {
        headers: buildForwardHeaders(request.headers, userId, containerId, env),
      })

      return stub.fetch(wsReq)
    }

    //
    // HTTP API routes
    //

    const auth = authenticate(request, env.OPENCLAW_GATEWAY_TOKEN)

    if (!auth.ok) {
      return withCors(unauthorizedResponse(auth.reason))
    }

    const { userId } = auth

    const rl = await checkRateLimit(userId, undefined, ctx)

    if (!rl.allowed) {
      return withCors(new Response(
        JSON.stringify({ error: 'rate_limit_exceeded' }),
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'Content-Type': 'application/json'
          }
        }
      ))
    }

    const containerId = pickContainer(userId)

    const stub = env.OPENCLAW.get(
      env.OPENCLAW.idFromName(containerId)
    ) as unknown as OpenClawContainer

    const proxied = new Request(
      `http://container${path.replace(/^\/api/, '') || '/'}${url.search}`,
      {
        method: request.method,
        headers: buildForwardHeaders(request.headers, userId, containerId, env),
        body: request.body,
      }
    )

    return withCors(await stub.fetch(proxied))
  }
}

//
// ─────────────────────────────────────────────────────────
// Container Durable Object
// ─────────────────────────────────────────────────────────
//

export class OpenClawContainer extends Container {

  defaultPort = 18789
  sleepAfter = '30m'
  enableInternet = true

  pingEndpoint = 'http://localhost:18789/healthz'
  startupTimeout = 120000

  private started = false

  override onStart() {
    console.log('[Container] started')
  }

  override onStop() {
    console.log('[Container] stopped')
  }

  override onError(e: unknown) {
    console.error('[Container] error:', e)
    throw e
  }

  override async fetch(request: Request): Promise<Response> {

    const envHeader = request.headers.get('X-Container-Env')
    const envVars = envHeader ? JSON.parse(envHeader) : {}

    if (!this.started) {

      this.started = true

      console.log('[Container] First request — starting with env vars:',
        Object.keys(envVars).join(', ')
      )

      await this.startAndWaitForPorts({
        envVars: {
          NODE_ENV: 'production',
          HOME: '/home/node',
          TERM: 'xterm-256color',
          OPENCLAW_STATE_DIR: '/home/node/.openclaw',
          ...envVars
        }
      })
    }

    const headers = new Headers(request.headers)
    headers.delete('X-Container-Env')

    const cleanReq = new Request(request.url, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? request.body
        : undefined,
    })

    return this.containerFetch(cleanReq)
  }
}

//
// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
//

function buildForwardHeaders(
  original: Headers,
  userId: string,
  containerId: string,
  env: Env
): Headers {

  const h = new Headers(original)

  h.set('X-OpenClaw-User', userId)
  h.set('X-OpenClaw-Shard', containerId)

  h.delete('Authorization')

  h.set('X-Container-Env', JSON.stringify({
    OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '',
    OPENCLAW_WORKER_URL: env.OPENCLAW_WORKER_URL ?? '',
    CONTAINER_SHARD_ID: containerId
  }))

  return h
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, X-Bot-Token, X-User-Id',
  }
}

function withCors(r: Response): Response {
  const res = new Response(r.body, r)

  Object.entries(corsHeaders()).forEach(([k, v]) => {
    res.headers.set(k, v)
  })

  return res
}