/**
 * @deepseek-ai/dsh-auth — embedded login/registration + signed-token auth.
 *
 * Plan A backend: a Cordis service (`ctx.auth`) backing the `/api/auth/*`
 * routes (registered by the API proxy) with a file user store, scrypt password
 * hashing, and HMAC-signed base64url bearer tokens. No external dependencies.
 *
 * SECURITY MODEL: single trusted deployment. The token is signed, not encrypted;
 * the secret is persisted under the harness home so it survives restarts. For
 * untrusted multi-tenant use, front this with a separate identity provider.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Pull in the `webServer` service augmentation on `Context` (declared by the
// webserver package) so `ctx.webServer.register(...)` types here.
import type {} from '@deepseek-ai/dsh-host-webserver'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AuthUser {
  userId: string
  username: string
  role: string
}

interface UserRecord extends AuthUser {
  passhash: string
  salt: string
  createdAt: string
}

export interface AuthConfig {
  /** Override the harness home; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Token signing secret; defaults to a persisted per-home secret. */
  secret?: string
}

// ---------------------------------------------------------------------------
// Persistence (one JSON file under the harness home)
// ---------------------------------------------------------------------------
const USERS_REL = ['users', 'auth-users.json']
const SECRET_REL = ['users', '.auth-secret']

function usersPath(home: string): string {
  return join(home, ...USERS_REL)
}
function secretPath(home: string): string {
  return join(home, ...SECRET_REL)
}

function loadUsers(home: string): UserRecord[] {
  const file = usersPath(home)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as UserRecord[]) : []
  } catch {
    return []
  }
}

function saveUsers(home: string, users: UserRecord[]): void {
  const file = usersPath(home)
  mkdirSync(join(home, 'users'), { recursive: true })
  writeFileSync(file, JSON.stringify(users, null, 2))
}

/** Stable, persisted signing secret so tokens survive process restarts. */
function resolveSecret(home: string, configured?: string): string {
  if (configured && configured.length > 0) return configured
  const file = secretPath(home)
  if (existsSync(file)) {
    try {
      const v = readFileSync(file, 'utf8').trim()
      if (v.length > 0) return v
    } catch { /* fall through to generate */ }
  }
  const generated = randomBytes(32).toString('hex')
  mkdirSync(join(home, 'users'), { recursive: true })
  writeFileSync(file, generated, { mode: 0o600 })
  return generated
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

/**
 * Seed a freshly registered account with the shared-root credentials
 * (`<home>/.credentials.yaml`) so a new account can authenticate LLM providers
 * immediately, without a manual Models-page write. Idempotent: never touches an
 * existing per-account credentials file, so an account that later edits its own
 * keys keeps them. Failure is non-fatal — a missing shared file or a write
 * error must not block registration.
 */
function seedSharedCredentials(home: string, userId: string): void {
  try {
    const shared = join(home, '.credentials.yaml')
    if (!existsSync(shared)) return
    const targetDir = join(home, 'users', userId)
    const target = join(targetDir, '.credentials.yaml')
    if (existsSync(target)) return
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, readFileSync(shared, 'utf8'))
  } catch (error) {
    // Non-fatal: registration succeeds even if seeding fails.
    console.error(`[auth] failed to seed credentials for ${userId}:`, error)
  }
}


function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function makeToken(secret: string, user: AuthUser): string {
  const body = Buffer.from(JSON.stringify({
    userId: user.userId, username: user.username, role: user.role, iat: Date.now(),
  })).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

function verifyToken(secret: string, token: string | undefined): AuthUser | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = sign(secret, body)
  const got = Buffer.from(sig)
  const want = Buffer.from(expected)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!data.userId) return null
    return { userId: data.userId, username: data.username, role: data.role }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Embedded login/registration auth (Plan A). Absent in headless/CLI. */
    auth?: AuthService
  }
}

export class AuthService extends Service {
  private readonly home: string
  private readonly secret: string
  private cache: UserRecord[] | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: AuthConfig = {}) {
    super(ctx, 'auth')
    this.home = resolveDshHome(config.dshHome)
    this.secret = resolveSecret(this.home, config.secret)
  }

  private async read(): Promise<UserRecord[]> {
    if (this.cache === undefined) this.cache = loadUsers(this.home)
    return this.cache
  }

  private async write(users: UserRecord[]): Promise<void> {
    // Serialize writes so concurrent register/login calls cannot clobber.
    this.writeChain = this.writeChain.then(() => {
      saveUsers(this.home, users)
      this.cache = users
    })
    await this.writeChain
  }

  async register(username: string, password: string, role = 'user'): Promise<AuthUser> {
    const name = username.trim()
    const pw = password
    const r = role.trim() || 'user'
    if (name.length < 3) throw new AuthError('username must be at least 3 characters', 400)
    if (pw.length < 6) throw new AuthError('password must be at least 6 characters', 400)
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new AuthError('username has invalid characters', 400)
    const users = await this.read()
    if (users.some(u => u.username === name)) throw new AuthError('username already taken', 409)
    const salt = randomBytes(16).toString('hex')
    const rec: UserRecord = {
      userId: randomUUID(),
      username: name,
      salt,
      passhash: hashPassword(pw, salt),
      role: r,
      createdAt: new Date().toISOString(),
    }
    await this.write([...users, rec])
    // Per-user isolation: give the fresh account the shared-root credentials so
    // provider calls (llm-pi-ai etc.) resolve immediately on first login.
    seedSharedCredentials(this.home, rec.userId)
    return { userId: rec.userId, username: rec.username, role: rec.role }
  }

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const name = username.trim()
    const users = await this.read()
    const rec = users.find(u => u.username === name)
    if (!rec || !verifyPassword(password, rec.salt, rec.passhash)) {
      throw new AuthError('invalid username or password', 401)
    }
    const user: AuthUser = { userId: rec.userId, username: rec.username, role: rec.role }
    return { token: makeToken(this.secret, user), user }
  }

  resolveToken(token: string | undefined): AuthUser | null {
    return verifyToken(this.secret, token)
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const users = await this.read()
    const rec = users.find(u => u.userId === userId)
    return rec === undefined
      ? null
      : { userId: rec.userId, username: rec.username, role: rec.role }
  }

  async listUsers(): Promise<AuthUser[]> {
    const users = await this.read()
    return users.map(({ userId, username, role }) => ({ userId, username, role }))
  }
}

export class AuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Cordis plugin entry (provides ctx.auth + the /api/auth routes + resolver)
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setRequestUserResolver, type RequestLike } from '@deepseek-ai/dsh-home-paths'

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function bearerOf(req: RequestLike): string | undefined {
  const h = req.headers as { get?(name: string): string | null | undefined; [key: string]: unknown }
  const raw = typeof h.get === 'function' ? h.get('authorization') : h['authorization']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  if (req.url !== undefined) {
    try {
      const tok = new URL(req.url, 'http://x').searchParams.get('token')
      if (tok) return tok
    } catch { /* ignore */ }
  }
  return undefined
}

export const name = '@deepseek-ai/dsh-auth'
export const inject = ['webServer']
export function apply(ctx: Context, config: AuthConfig = {}): void {
  const auth = new AuthService(ctx, config)

  // Scope each inbound request to its authenticated user so user-data providers
  // (credentials/settings/sessions) isolate by account via userScopedDshHome.
  setRequestUserResolver(req => auth.resolveToken(bearerOf(req))?.userId)

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/register',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req) as { username?: string; password?: string; role?: string }
        const user = await auth.register(body.username ?? '', body.password ?? '', body.role ?? 'user')
        ctx.logger?.info?.(`[auth] registered user ${user.username}`)
        sendJson(res, 201, { ok: true, user })
      } catch (e) {
        const err = e as Error & { status?: number }
        sendJson(res, err.status ?? 400, { error: err.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/login',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req) as { username?: string; password?: string }
        const { token, user } = await auth.login(body.username ?? '', body.password ?? '')
        sendJson(res, 200, { ok: true, token, user })
      } catch (e) {
        const err = e as Error & { status?: number }
        sendJson(res, err.status ?? 400, { error: err.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/me',
    handler: (req, res) => {
      const claims = auth.resolveToken(bearerOf(req))
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, { ok: true, user: claims })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/protected',
    handler: (req, res) => {
      const claims = auth.resolveToken(bearerOf(req))
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, { ok: true, message: `hello ${claims.username} (role=${claims.role})` })
    },
  })

  ctx.logger?.info?.('[auth] routes registered: /api/auth/{register,login,me,protected}')
}
