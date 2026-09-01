/**
 * Web login gate auth helper.
 *
 * Talks to the auth plugin's HTTP routes (registered by `scratch-plugin`'s
 * `auth-plugin.ts` when `dsh web` is launched with the `--patch` that inserts
 * it). The token + user profile are kept in `localStorage` under `dsh.auth`
 * so the client runtime can read the logged-in `userId` for per-user session
 * scoping (see packages/client/runtime/src/client/auth-context.ts).
 *
 * This is the "Plan A" feasibility layer from the design notes: it gates the
 * UI and carries identity, but the single-process `ctx.sessions` is NOT a
 * security boundary. For untrusted multi-tenant use, run a separate instance
 * per user (Plan B) instead.
 */

export interface AuthUser {
  userId: string
  username: string
  role: string
}

export interface AuthState {
  token: string
  user: AuthUser
}

const STORAGE_KEY = 'dsh.auth'

export function loadAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AuthState>
    if (typeof parsed.token === 'string' && parsed.user && typeof parsed.user.userId === 'string') {
      return parsed as AuthState
    }
  } catch {
    /* ignore malformed storage */
  }
  return null
}

export function saveAuth(state: AuthState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((data.error as string) ?? `request failed: ${res.status}`)
  }
  return data as T
}

export async function login(username: string, password: string): Promise<AuthState> {
  const data = await postJson<{ token: string; user: AuthUser }>('/api/auth/login', { username, password })
  const state: AuthState = { token: data.token, user: data.user }
  saveAuth(state)
  return state
}

export async function register(username: string, password: string, role = 'user'): Promise<AuthState> {
  await postJson<{ ok: true; userId: string }>('/api/auth/register', { username, password, role })
  // Auto-login after a successful registration.
  return login(username, password)
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/me', { headers: authHeaders(token) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error((data.error as string) ?? 'unauthorized')
  return data.user as AuthUser
}
