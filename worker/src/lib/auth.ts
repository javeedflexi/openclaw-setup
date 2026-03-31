// lib/auth.ts
// Authentication helpers.
// Supports two modes:
//   1. Bearer token  — direct API / WebChat access
//   2. Webhook token — Telegram / Slack / Discord webhooks using X-Bot-Token
//
// For production: replace the simple token check with proper JWT validation.

export interface AuthResult {
  ok:     true
  userId: string
  mode:   'bearer' | 'webhook'
}
export interface AuthFailure { ok: false; reason: string }
export type Auth = AuthResult | AuthFailure

// ── Main auth entry point ─────────────────────────────────────────────────────
export function authenticate(request: Request, gatewayToken: string): Auth {

  // Webhook path: messaging platforms send X-Bot-Token + X-User-Id
  const botToken = request.headers.get('X-Bot-Token')
  if (botToken) {
    if (!timingSafeEqual(botToken, gatewayToken)) {
      return { ok: false, reason: 'invalid bot token' }
    }
    const userId = sanitizeUserId(
      request.headers.get('X-User-Id') ?? 'webhook-anon'
    )
    return { ok: true, userId, mode: 'webhook' }
  }

  // Bearer token path
  const auth = request.headers.get('Authorization') ?? ''
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    if (token.length < 8) {
      return { ok: false, reason: 'token too short' }
    }
    // Simple mode: first 16 hex chars of the token become the userId.
    // Swap this for JWT sub claim extraction in production.
    const userId = `u-${token.slice(0, 16)}`
    return { ok: true, userId, mode: 'bearer' }
  }

  return { ok: false, reason: 'no credentials' }
}

// ── Timing-safe string comparison (prevents timing attacks) ───────────────────
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  let result = 0
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i]
  return result === 0
}

// ── Sanitize userId — alphanumeric + dash/underscore only ─────────────────────
function sanitizeUserId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64) || 'anon'
}

// ── Build standard auth error response ───────────────────────────────────────
export function unauthorizedResponse(reason: string): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', reason }), {
    status:  401,
    headers: {
      'Content-Type':     'application/json',
      'WWW-Authenticate': 'Bearer realm="openclaw"',
    },
  })
}
