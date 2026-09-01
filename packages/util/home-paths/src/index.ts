/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

// ---------------------------------------------------------------------------
// Per-request authenticated user (Plan A isolation)
//
// A single `dsh web` process serves many accounts. The authenticated user for
// the *current* request is carried in an AsyncLocalStorage slot, set by the
// connection layer when an `Authorization` bearer token is present. Every
// user-data root resolver consults it so sessions/credentials/settings land
// under `~/.dsh/users/<id>/` instead of the shared `~/.dsh`. With no active
// user (CLI/headless, or pre-login), resolution falls back to `~/.dsh`, so
// single-user behaviour is unchanged.
// ---------------------------------------------------------------------------
// The active-user slot and the request→user resolver live on `globalThis`
// instead of module-local state. The web runtime bundles (inlines) this module,
// while the source-loaded auth plugin imports the package build — two physical
// copies. A module-local variable would make the resolver set by one copy
// invisible to the other, so per-request scoping would silently no-op and one
// account could read another's sessions. A process-global slot is shared by
// every copy, which is exactly what Plan A isolation requires.
const ACTIVE_USER_ALS = Symbol.for('@deepseek-ai/dsh-home-paths/active-user')
const REQUEST_USER_RESOLVER = Symbol.for('@deepseek-ai/dsh-home-paths/request-user-resolver')

function globalSlot(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>
}

function activeUserStore(): AsyncLocalStorage<string | undefined> {
  const slot = globalSlot()
  let als = slot[ACTIVE_USER_ALS] as AsyncLocalStorage<string | undefined> | undefined
  if (als === undefined) {
    als = new AsyncLocalStorage<string | undefined>()
    slot[ACTIVE_USER_ALS] = als
  }
  return als
}

/**
 * Run `callback` with `userId` bound as the active authenticated user.
 * Pass `undefined` to scope work to the shared (anonymous) home.
 * @param userId - the authenticated user id, or `undefined` for none.
 * @param callback - work executed under the scoped identity.
 * @returns the callback's return value.
 */
export function runWithActiveUser<T>(userId: string | undefined, callback: () => T): T {
  return activeUserStore().run(userId, callback)
}

/**
 * The active authenticated user for the current async context, if any.
 * @returns the user id, or `undefined` when no user is scoped.
 */
export function getActiveUserId(): string | undefined {
  return activeUserStore().getStore()
}

/**
 * A request carrying an HTTP `authorization` header, in either Node
 * `IncomingMessage` form or Fetch `Request` form. The public `/api` RPC channel
 * is served through the Fetch handler, so both shapes must be supported by a
 * resolver.
 */
export interface RequestLike {
  readonly headers:
    | { readonly [key: string]: string | string[] | undefined }
    | { get(name: string): string | null | undefined }
  readonly url?: string | undefined
}

/**
 * Resolves the authenticated user id from an inbound request. Installed by the
 * auth layer (Plan A) so the connection transport can scope each RPC to the
 * caller; `undefined` means anonymous (no scoping).
 */
export type RequestUserResolver = (req: RequestLike) => string | undefined

/**
 * Install the process-wide request→user resolver. Safe to call once at boot.
 * Stored on `globalThis` so every copy of this module shares it; see the note
 * on {@link runWithActiveUser} for why a module-local variable would break it.
 * @param resolver - maps an inbound request to its user id, or `undefined`.
 */
export function setRequestUserResolver(resolver: RequestUserResolver | undefined): void {
  globalSlot()[REQUEST_USER_RESOLVER] = resolver
}

/**
 * The installed request→user resolver, if any.
 * @returns the resolver, or `undefined` when auth is not mounted.
 */
export function getRequestUserResolver(): RequestUserResolver | undefined {
  return globalSlot()[REQUEST_USER_RESOLVER] as RequestUserResolver | undefined
}

/**
 * Whether this deployment authenticates callers at all. True once an auth
 * layer has installed a request→user resolver; false for headless/CLI and for
 * any deployment without a login gate.
 *
 * This is the switch between the two visibility regimes: an authenticating
 * deployment isolates per account, an unauthenticated one keeps the
 * single-user behaviour where every artifact is visible.
 * @returns true when requests are scoped to authenticated accounts.
 */
export function isolationActive(): boolean {
  return getRequestUserResolver() !== undefined
}

/**
 * The single visibility predicate every per-user data path must consult.
 * Call this instead of comparing {@link getActiveUserId} against an owner
 * inline — a hand-rolled comparison is how a new data domain silently ships
 * without isolation.
 *
 * Fails closed: on an authenticating deployment, an anonymous caller (no
 * active user) sees **nothing**, and a caller only sees artifacts it owns.
 * On an unauthenticated deployment everything stays visible, so headless and
 * single-user behaviour is unchanged.
 * @param owner - the owning account id recorded when the artifact was
 * created, or `undefined` for artifacts created with no active user.
 * @returns true when the current caller may read the artifact.
 */
export function isVisibleTo(owner: string | undefined): boolean {
  if (!isolationActive()) return true
  const activeUserId = getActiveUserId()
  if (activeUserId === undefined) return false
  return owner === activeUserId
}

/**
 * Resolve the DeepSeek Harness home, namespaced to the active authenticated
 * user when one is present. Falls back to the single-root home otherwise.
 *
 * Used by user-data providers (credentials, settings, session backends) so
 * every account's data is isolated under `~/.dsh/users/<id>/`.
 * @param configured - explicit harness-home override.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the absolute, user-scoped harness home path.
 */
export function userScopedDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const base = resolveDshHome(configured, env)
  const id = getActiveUserId()
  return id === undefined ? base : join(base, 'users', id)
}

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root DeepSeek Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.dsh`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.dsh`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultDshHome()) ? DEFAULT_DSH_HOME_DISPLAY : `$${DSH_HOME_ENV}`
}
