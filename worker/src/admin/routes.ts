// admin/routes.ts
// Internal admin API — protected by the gateway token.
// Routes:
//   GET  /admin/shards               — list all shards + container status
//   GET  /admin/shards/:n/status     — single shard detail
//   POST /admin/shards/:n/restart    — force-sleep a shard (it will cold-start on next req)
//   POST /admin/routing/flush        — clear all KV routing cache
//   GET  /admin/metrics              — aggregate request + rate-limit metrics
//   POST /admin/register-telegram    — register Telegram webhook URL
//   POST /admin/register-slack       — instructions for Slack setup
//   POST /admin/channels/add         — proxy a channel-add command to a shard

import { getContainer }          from '@cloudflare/containers'
import { NUM_SHARDS, shardKey }  from '../lib/shard'
import { registerTelegramWebhook } from '../webhooks/telegram'
import type { Env }              from '../worker'

export async function handleAdmin(
  request: Request,
  env:     Env,
  ctx:     ExecutionContext,
): Promise<Response> {
  const url    = new URL(request.url)
  const path   = url.pathname.replace(/^\/admin\/?/, '')
  const method = request.method

  // ── GET /admin/shards ─────────────────────────────────────────────────────
  if (path === 'shards' && method === 'GET') {
    const shards = []
    for (let i = 0; i < NUM_SHARDS; i++) {
      const key  = shardKey(i)
      const stub = getContainer(env.OPENCLAW, key)
      // Probe the container health endpoint
      let health: unknown = 'unknown'
      try {
        const r = await stub.containerFetch('http://container:18790/status', 18790)
        health  = r.ok ? await r.json() : { error: `http ${r.status}` }
      } catch (e) {
        health = { error: String(e) }
      }
      shards.push({ id: i, key, health })
    }
    return Response.json({ shards, total: NUM_SHARDS, ts: Date.now() })
  }

  // ── GET /admin/shards/:n/status ───────────────────────────────────────────
  const shardMatch = path.match(/^shards\/(\d+)\/status$/)
  if (shardMatch && method === 'GET') {
    const id   = parseInt(shardMatch[1], 10)
    if (id < 0 || id >= NUM_SHARDS) {
      return Response.json({ error: 'shard out of range' }, { status: 400 })
    }
    const stub = getContainer(env.OPENCLAW, shardKey(id))
    try {
      const r    = await stub.containerFetch('http://container:18790/status', 18790)
      const data = r.ok ? await r.json() : { error: `http ${r.status}` }
      return Response.json({ shard: id, ...data as object })
    } catch (e) {
      return Response.json({ shard: id, error: String(e), sleeping: true })
    }
  }

  // ── POST /admin/shards/:n/restart ─────────────────────────────────────────
  const restartMatch = path.match(/^shards\/(\d+)\/restart$/)
  if (restartMatch && method === 'POST') {
    const id  = parseInt(restartMatch[1], 10)
    if (id < 0 || id >= NUM_SHARDS) {
      return Response.json({ error: 'shard out of range' }, { status: 400 })
    }
    // Sending SIGTERM via /admin/shutdown causes the container to flush to R2
    const stub = getContainer(env.OPENCLAW, shardKey(id))
    try {
      await stub.containerFetch('http://container:18789/admin/shutdown', 18789)
    } catch { /* container may already be sleeping */ }
    return Response.json({ ok: true, message: `shard ${id} signalled to restart` })
  }

  // ── POST /admin/routing/flush ─────────────────────────────────────────────
  if (path === 'routing/flush' && method === 'POST') {
    const list    = await env.ROUTING_KV.list({ prefix: 'shard:' })
    const deleted = list.keys.length
    await Promise.all(list.keys.map(k => env.ROUTING_KV.delete(k.name)))
    return Response.json({ ok: true, deleted, message: 'routing cache cleared' })
  }

  // ── GET /admin/metrics ────────────────────────────────────────────────────
  if (path === 'metrics' && method === 'GET') {
    // Count rate-limit entries (active users in last minute)
    const rlList = await env.ROUTING_KV.list({ prefix: 'rl:' })
    const activeUsers = new Set(
      rlList.keys.map(k => k.name.split(':')[1])
    ).size

    const shardList   = await env.ROUTING_KV.list({ prefix: 'shard:' })
    const routedUsers = shardList.keys.length

    return Response.json({
      activeUsersLastMin:  activeUsers,
      routedUsersTotal:    routedUsers,
      numShards:           NUM_SHARDS,
      ts:                  Date.now(),
    })
  }

  // ── POST /admin/register-telegram ─────────────────────────────────────────
  if (path === 'register-telegram' && method === 'POST') {
    const body      = await request.json() as { workerUrl: string }
    const result    = await registerTelegramWebhook(
      body.workerUrl,
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_WEBHOOK_SECRET,
    )
    return Response.json(result)
  }

  // ── POST /admin/channels/add — proxy channel command to a specific shard ──
  if (path === 'channels/add' && method === 'POST') {
    const body     = await request.json() as { shardId?: number; channel: string; token: string }
    const id       = body.shardId ?? 0
    const stub     = getContainer(env.OPENCLAW, shardKey(id))
    const fwdReq   = new Request('http://container:18789/admin/channels/add', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Token':  env.OPENCLAW_GATEWAY_TOKEN,
      },
      body: JSON.stringify({ channel: body.channel, token: body.token }),
    })
    const r = await stub.fetch(fwdReq)
    return new Response(r.body, { status: r.status, headers: r.headers })
  }

  return Response.json({ error: 'admin route not found' }, { status: 404 })
}
