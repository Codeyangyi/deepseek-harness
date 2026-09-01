/**
 * @deepseek-ai/dsh-auth (proof-of-concept plugin)
 *
 * Demonstrates how to add a login/registration layer to `dsh web` WITHOUT
 * touching core packages: register HTTP routes through the `webServer`
 * service and keep a user store on disk. This is the backend half of "Plan A".
 *
 * SECURITY NOTE: this is a feasibility skeleton, not production auth.
 *  - token secret is a dev fallback (set DSH_AUTH_SECRET in real use)
 *  - user store is a single JSON file (no concurrency control)
 *  - single-process `ctx.sessions` is NOT a security boundary (see README note)
 * For multi-tenant untrusted users, use Plan B (separate app + dsh backend).
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac,
} from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const USERS_DIR = join(homedir(), '.dsh', 'users')
const USERS_FILE = join(USERS_DIR, 'auth-users.json')
const TOKEN_SECRET = process.env.DSH_AUTH_SECRET || 'dev-only-insecure-secret-change-me'

interface UserRecord {
  id: string
  username: string
  passhash: string
  salt: string
  role: string
  createdAt: string
}

function loadUsers(): UserRecord[] {
  if (!existsSync(USERS_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveUsers(users: UserRecord[]): void {
  mkdirSync(USERS_DIR, { recursive: true })
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

// ---------------------------------------------------------------------------
// Crypto helpers (scrypt password hashing + HMAC-signed base64url token)
// ---------------------------------------------------------------------------
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sign(body: string): string {
  return createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
}

function makeToken(user: UserRecord): string {
  const body = Buffer.from(JSON.stringify({
    userId: user.id, username: user.username, role: user.role, iat: Date.now(),
  })).toString('base64url')
  return `${body}.${sign(body)}`
}

function verifyToken(token: string | undefined): { userId: string; username: string; role: string } | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  if (sign(body) !== sig) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!data.userId) return null
    return { userId: data.userId, username: data.username, role: data.role }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    let tooBig = false
    req.on('data', (chunk: string | Buffer) => {
      data += chunk.toString()
      if (data.length > 1_000_000) { tooBig = true; req.destroy() }
    })
    req.on('end', () => {
      if (tooBig) return reject(new Error('payload too large'))
      try { resolve(data ? JSON.parse(data) : {}) }
      catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res: import('node:http').ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function bearer(req: import('node:http').IncomingMessage): string | undefined {
  const h = req.headers['authorization']
  if (!h) return undefined
  return h.startsWith('Bearer ') ? h.slice(7) : undefined
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export const name = 'auth-plugin'
export const inject = ['webServer']

export function apply(ctx: Context): void {
  const users = loadUsers()
  const persist = () => saveUsers(users)

  const disposeRegister = ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/register',
    handler: async (req, res) => {
      try {
        const body = await readJson(req) as { username?: string; password?: string; role?: string }
        const username = (body.username ?? '').trim()
        const password = body.password ?? ''
        const role = (body.role ?? 'user').trim() || 'user'
        if (username.length < 3) return sendJson(res, 400, { error: 'username must be >= 3 chars' })
        if (password.length < 6) return sendJson(res, 400, { error: 'password must be >= 6 chars' })
        if (users.some((u) => u.username === username)) return sendJson(res, 409, { error: 'username taken' })
        const salt = randomBytes(16).toString('hex')
        const rec: UserRecord = {
          id: randomUUID(),
          username,
          salt,
          passhash: hashPassword(password, salt),
          role,
          createdAt: new Date().toISOString(),
        }
        users.push(rec)
        persist()
        ctx.logger?.info?.(`[auth] registered user ${username}`)
        sendJson(res, 201, { ok: true, userId: rec.id })
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message })
      }
    },
  })

  const disposeLogin = ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/login',
    handler: async (req, res) => {
      try {
        const body = await readJson(req) as { username?: string; password?: string }
        const username = (body.username ?? '').trim()
        const password = body.password ?? ''
        const rec = users.find((u) => u.username === username)
        if (!rec || !verifyPassword(password, rec.salt, rec.passhash)) {
          return sendJson(res, 401, { error: 'invalid credentials' })
        }
        sendJson(res, 200, {
          ok: true,
          token: makeToken(rec),
          user: { userId: rec.id, username: rec.username, role: rec.role },
        })
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message })
      }
    },
  })

  const disposeMe = ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/me',
    handler: (req, res) => {
      const claims = verifyToken(bearer(req))
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, { ok: true, user: claims })
    },
  })

  // Demonstrates how a protected route gates on the token — the same pattern
  // the web client / session layer would use to scope data by account.
  const disposeProtected = ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/protected',
    handler: (req, res) => {
      const claims = verifyToken(bearer(req))
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, { ok: true, message: `hello ${claims.username} (role=${claims.role})` })
    },
  })

  ctx.on('dispose', () => {
    disposeRegister()
    disposeLogin()
    disposeMe()
    disposeProtected()
  })

  ctx.logger?.info?.('[auth] routes registered: /api/auth/{register,login,me,protected}')
}
