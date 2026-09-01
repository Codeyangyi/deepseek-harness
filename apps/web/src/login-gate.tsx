/**
 * Login / registration gate rendered before the real shell boots.
 *
 * Mounted into a transient overlay on <body>; on success it removes itself and
 * invokes `onAuthed` so the caller can launch {@link AppWebEntry} into #root.
 * Keeping the gate in a separate DOM tree avoids colliding with the shell's own
 * React root.
 */
import { StrictMode, useState, type FormEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { login, register, type AuthState } from './auth'

type Mode = 'login' | 'register'

interface Props {
  onAuthed: (state: AuthState) => void
}

function LoginGate({ onAuthed }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const state = mode === 'login'
        ? await login(username, password)
        : await register(username, password, role)
      onAuthed(state)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={overlay}>
      <form style={card} onSubmit={submit}>
        <h1 style={title}>{mode === 'login' ? '登录' : '注册'}</h1>
        <p style={subtitle}>DeepSeek Harness · 账号访问</p>

        <label style={label} htmlFor="dsh-username">用户名</label>
        <input
          id="dsh-username"
          style={input}
          value={username}
          autoComplete="username"
          onChange={e => setUsername(e.target.value)}
          placeholder="至少 3 个字符"
        />

        <label style={label} htmlFor="dsh-password">密码</label>
        <input
          id="dsh-password"
          type="password"
          style={input}
          value={password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={e => setPassword(e.target.value)}
          placeholder="至少 6 个字符"
        />

        {mode === 'register' && (
          <>
            <label style={label} htmlFor="dsh-role">角色</label>
            <select
              id="dsh-role"
              style={input}
              value={role}
              onChange={e => setRole(e.target.value)}
            >
              <option value="user">user（普通用户）</option>
              <option value="admin">admin（管理员）</option>
            </select>
          </>
        )}

        {error !== null && <div style={errorBox}>{error}</div>}

        <button style={button} type="submit" disabled={busy}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <button
          type="button"
          style={switchLink}
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}
        >
          {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  )
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(15, 23, 42, 0.92)',
  zIndex: 99999,
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
}

const card: React.CSSProperties = {
  width: 360,
  maxWidth: '90vw',
  padding: '32px 28px',
  borderRadius: 12,
  background: '#0f172a',
  color: '#e2e8f0',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const title: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700 }
const subtitle: React.CSSProperties = { margin: '0 0 12px', fontSize: 13, color: '#94a3b8' }
const label: React.CSSProperties = { fontSize: 13, color: '#cbd5e1', marginTop: 4 }
const input: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #334155',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: 14,
}
const button: React.CSSProperties = {
  marginTop: 14,
  padding: '11px 12px',
  borderRadius: 8,
  border: 'none',
  background: '#2563eb',
  color: 'white',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
}
const switchLink: React.CSSProperties = {
  marginTop: 6,
  background: 'none',
  border: 'none',
  color: '#60a5fa',
  fontSize: 13,
  cursor: 'pointer',
}
const errorBox: React.CSSProperties = {
  marginTop: 4,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(220,38,38,0.15)',
  color: '#fca5a5',
  fontSize: 13,
}

/** Render the gate into a body overlay; resolves nothing — drives `onAuthed`. */
export function renderLoginGate(onAuthed: (state: AuthState) => void): void {
  const host = document.createElement('div')
  host.id = 'dsh-login-gate'
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(
    <StrictMode>
      <LoginGate
        onAuthed={(state) => {
          root.unmount()
          host.remove()
          onAuthed(state)
        }}
      />
    </StrictMode>,
  )
}
