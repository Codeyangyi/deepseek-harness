/**
 * Web application entry. Before booting the real shell ({@link AppWebEntry}),
 * this gates on an authenticated account: a stored, valid token launches the
 * shell directly; otherwise a login/registration overlay is shown. On success
 * the account badge (username + role + logout) is mounted.
 *
 * The auth routes live in `scratch-plugin`'s `auth-plugin.ts`; run
 * `pnpm dsh web --patch ./scratch-plugin/cordis.yml` so they are registered.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { loadAuth, type AuthState } from './auth'
import { renderLoginGate } from './login-gate'
import { mountAccountBadge } from './account-badge'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')

function launchShell(): void {
  void new AppWebEntry(el as HTMLElement).run()
}

function onAuthed(state: AuthState): void {
  launchShell()
  mountAccountBadge(state.user)
}

const existing = loadAuth()
if (existing !== null) {
  // Stored token present — boot straight into the shell and show the badge.
  // (A stale token still boots the UI; the API layer will reject calls and the
  // user can log out via the badge to re-authenticate.)
  onAuthed(existing)
} else {
  renderLoginGate(onAuthed)
}
