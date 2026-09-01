/**
 * Per-account session scoping (Plan A login gate): reads the logged-in user
 * and token from localStorage (written by apps/web/src/auth.ts under
 * `dsh.auth`). The client runtime namespaces new sessions and filters the
 * sidebar by the owner prefix, and the web shell feeds the token to the API
 * carrier so every HTTP RPC and WebSocket stream carries the caller's
 * identity. Guarded — returns undefined when not authenticated, so the
 * single-user behavior and every existing test are unchanged.
 */

const STORAGE_KEY = 'dsh.auth'

interface StoredAuth {
  token: string
  user: { userId: string; username: string; role: string }
}

function readAuth(): StoredAuth | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<StoredAuth>
    if (
      typeof parsed.token === 'string'
      && parsed.user !== undefined
      && typeof parsed.user.userId === 'string'
    ) {
      return parsed as StoredAuth
    }
  } catch {
    /* ignore malformed storage */
  }
  return null
}

/** The logged-in account id, or undefined when not authenticated. */
export function getCurrentUserId(): string | undefined {
  return readAuth()?.user.userId
}

/** The logged-in bearer token, or undefined when not authenticated. */
export function getCurrentToken(): string | undefined {
  return readAuth()?.token
}

/** Stable owner prefix for namespacing a session id under an account. */
export function sessionOwnerPrefix(userId: string): string {
  return `${userId}__`
}

/** Whether a session id belongs to the given account (created under its prefix). */
export function isOwnedBy(sessionId: string, userId: string): boolean {
  return sessionId.startsWith(sessionOwnerPrefix(userId))
}
