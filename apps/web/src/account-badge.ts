/**
 * Account badge: a fixed, DOM-injected indicator showing the logged-in account
 * and a logout action. This is the visible half of "show different operations
 * by account" — the badge renders the username and role, and an admin sees an
 * extra management hint that a normal user does not.
 *
 * Injected as plain DOM (not React) so it lives beside the shell's own React
 * root without contention.
 */
import { clearAuth, type AuthUser } from './auth'

export function mountAccountBadge(user: AuthUser): void {
  const existing = document.getElementById('dsh-account-badge')
  if (existing !== null) existing.remove()

  const badge = document.createElement('div')
  badge.id = 'dsh-account-badge'
  badge.style.cssText = [
    'position:fixed',
    'top:10px',
    'right:12px',
    'z-index:99998',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'padding:6px 10px',
    'border-radius:999px',
    'background:rgba(15,23,42,0.9)',
    'color:#e2e8f0',
    'font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';')

  const roleLabel = user.role === 'admin' ? '管理员' : '普通用户'
  const name = document.createElement('span')
  name.textContent = `${user.username}（${roleLabel}）`
  name.style.fontWeight = '600'

  const adminHint = document.createElement('span')
  adminHint.textContent = '· 用户管理'
  adminHint.style.color = '#60a5fa'
  adminHint.style.display = user.role === 'admin' ? 'inline' : 'none'

  const logout = document.createElement('button')
  logout.textContent = '退出'
  logout.style.cssText = [
    'border:none',
    'background:#334155',
    'color:#e2e8f0',
    'border-radius:999px',
    'padding:3px 10px',
    'cursor:pointer',
    'font-size:12px',
  ].join(';')
  logout.addEventListener('click', () => {
    clearAuth()
    window.location.reload()
  })

  badge.append(name, adminHint, logout)
  document.body.appendChild(badge)
}
