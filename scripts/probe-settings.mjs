#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = 3098
const BASE = `http://127.0.0.1:${PORT}`
const REPO = resolve('.')
const BIN = join(REPO, 'apps/cli/lib/bin.js')
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-probe-'))

function rpc(method, payload, token) {
  return fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p', method, payload }),
  })
}
async function authPost(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
async function waitUp(t) {
  const d = Date.now() + t
  while (Date.now() < d) {
    try { const r = await fetch(`${BASE}/api/auth/me`); if (r.status === 401) return true } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}
function killTree(pid) { try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }) } catch {} }

const child = spawn(process.execPath, [BIN, 'web', '--patch', './auth-patch.cordis.yml', '--port', String(PORT)], { cwd: REPO, env: { ...process.env, DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', d => log += d)
child.stderr.on('data', d => log += d)
const up = await waitUp(45000)
if (!up) { console.error('no boot\n' + log); killTree(child.pid); process.exit(1) }
try {
  const a = await authPost('/api/auth/register', { username: 'probe', password: 'probe123' })
  const login = await authPost('/api/auth/login', { username: 'probe', password: 'probe123' })
  const token = login.body.token
  const d = await (await rpc('settings.describe', {}, token)).json()
  console.log('DESCRIBE_OK=', d?.result?.ok)
  console.log('NAMESPACES=', JSON.stringify((d?.result?.value?.namespaces ?? []).map(n => ({ ns: n.ns, revision: n.revision, sampleValue: n.value }))))
  console.log('WRITABLE=', d?.result?.value?.writable, 'HASDOC=', d?.result?.value?.hasDocument)
} finally { killTree(child.pid) }
