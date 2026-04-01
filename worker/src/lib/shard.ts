// lib/shard.ts
// Shared shard-routing utilities used by the main Worker and webhook handlers.
// All routing decisions go through here — single source of truth.

export const NUM_SHARDS = 3   // raise this as user count grows
export const ROUTING_TTL_SEC = 3600 // 1-hour sticky affinity
export const RATE_LIMIT_RPM = 60   // max requests per minute per user

// ── Consistent hash: userId → shardId ────────────────────────────────────────
// SHA-256 based — same userId always maps to same shard across all Workers
export async function shardForUser(userId: string): Promise<number> {
  const data = new TextEncoder().encode(userId)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const arr = new Uint8Array(buf)
  const n = ((arr[0] << 24) | (arr[1] << 16) | (arr[2] << 8) | arr[3]) >>> 0
  return n % NUM_SHARDS
}

// ── Shard key used as Durable Object name ─────────────────────────────────────
export const shardKey = (id: number) => `shard-${id}`

// ── Resolve shard for user (with KV cache) ─────────────────────────────────────
export async function resolveShardForUser(
  userId: string,
  kv: KVNamespace,
  ctx: ExecutionContext,
): Promise<{ shardId: number; shardKey: string; cached: boolean }> {
  const kvKey = `shard:${userId}`
  const cached = await kv.get(kvKey)

  if (cached !== null) {
    const id = parseInt(cached, 10)
    return { shardId: id, shardKey: shardKey(id), cached: true }
  }

  const id = await shardForUser(userId)
  ctx.waitUntil(
    kv.put(kvKey, String(id), { expirationTtl: ROUTING_TTL_SEC })
  )
  return { shardId: id, shardKey: shardKey(id), cached: false }
}

// ── Invalidate a user's shard assignment (force re-hash on next request) ───────
export async function clearShardCache(userId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(`shard:${userId}`)
}

// ── Rate limiter (sliding window via KV) ──────────────────────────────────────
export async function checkRateLimit(
  userId: string,
  kv: KVNamespace,
  ctx: ExecutionContext,
): Promise<{ allowed: boolean; remaining: number }> {
  const minute = Math.floor(Date.now() / 60_000)
  const key = `rl:${userId}:${minute}`
  const raw = await kv.get(key)
  const count = raw ? parseInt(raw, 10) : 0

  if (count >= RATE_LIMIT_RPM) {
    return { allowed: false, remaining: 0 }
  }

  ctx.waitUntil(kv.put(key, String(count + 1), { expirationTtl: 120 }))
  return { allowed: true, remaining: RATE_LIMIT_RPM - count - 1 }
}
