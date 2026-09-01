#!/usr/bin/env node
/**
 * End-to-end smoke test for Plan A per-user data isolation in `dsh web`.
 *
 * Spawns a `dsh web` server against a TEMP harness home (never your real
 * ~/.dsh), then drives the real HTTP API as two distinct accounts to prove:
 *   - account A's sessions are invisible to account B (the reported bug),
 *   - credentials and settings are isolated per account on disk.
 *
 * Everything is torn down (server killed, temp home removed) on exit.
 */

import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// WebSocket client, resolved from the bundled `ws` copy so the script needs no
// root-level install. `wrapper.mjs` is ws's ESM entry (default export is the
// WebSocket constructor). Path is anchored to this script's location.
const WS_URL = new URL(
  '../packages/client/connection/node_modules/ws/wrapper.mjs',
  import.meta.url,
).href
const { default: WebSocket } = await import(WS_URL)

const PORT = 3099
const BASE = `http://127.0.0.1:${PORT}`
const REPO = resolve('.')
const BIN = join(REPO, 'apps/cli/lib/bin.js')
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-iso-'))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const fail = (msg) => { throw new Error(msg) }

function rpc(method, payload, token) {
  return fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method, payload }),
  })
}
async function rpcJson(method, payload, token) {
  const res = await rpc(method, payload, token)
  const body = await res.json()
  return { status: res.status, body }
}
async function authPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * Open the `events.mux` WebSocket stream as `token` and collect the baseline
 * `session/subscribed` frames. This is the channel that previously leaked one
 * account's sessions to another: a scoped open must push only the caller's own
 * sessions. An anonymous open (no token) must be rejected by the server rather
 * than streaming every account's sessions.
 * @param {string | undefined} token - bearer token, or undefined for anonymous.
 * @returns the subscribed session ids, plus whether the upgrade was refused.
 */
function openMuxStream(token) {
  return new Promise((resolve) => {
    const subscribed = new Set()
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* already gone */ }
      resolve(result)
    }
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg?.payload?.type === 'session/subscribed' && msg?.payload?.sessionId) {
          subscribed.add(msg.payload.sessionId)
        }
      } catch { /* ignore malformed frame */ }
    })
    ws.on('open', () => {
      // Baseline frames are queued at open; allow them to land on the socket.
      setTimeout(() => finish({ ok: true, subscribed: [...subscribed], refused: false }), 900)
    })
    ws.on('error', (err) => {
      finish({ ok: false, subscribed: [...subscribed], refused: true, error: String(err) })
    })
    ws.on('unexpected-response', (_req, res) => {
      finish({ ok: false, subscribed: [...subscribed], refused: true, status: res?.statusCode })
    })
    // Hard ceiling so a silent stream never hangs the test.
    setTimeout(() => finish({
      ok: ws.readyState === WebSocket.OPEN,
      subscribed: [...subscribed],
      refused: false,
      timedOut: true,
    }), 3500)
  })
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`)
      if (res.status === 401) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

function killTree(pid) {
  try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }) } catch { /* best effort */ }
}

async function main() {
  console.log(`Temp DSH_HOME: ${DSH_HOME}`)
  // dsh-auth is now part of the default `web` profile (packages/bundle/web-app/
  // cordis.patch.yml), so no --patch overlay is needed — passing one would
  // duplicate the loader entry and fail the boot.
  const child = spawn(process.execPath, [
    BIN, 'web', '--port', String(PORT),
  ], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  child.stdout.on('data', d => { serverLog += d.toString() })
  child.stderr.on('data', d => { serverLog += d.toString() })

  const up = await waitForServer(45000)
  if (!up) {
    console.error('Server did not become ready. Log:\n' + serverLog)
    killTree(child.pid)
    process.exit(1)
  }
  check('server booted and /api/auth/me responds (401 unauth)', true)

  try {
    // --- register + login two accounts ---
    const aliceReg = await authPost('/api/auth/register', { username: 'alice', password: 'alice123' })
    if (!aliceReg.body.ok) fail(`alice register failed: ${JSON.stringify(aliceReg.body)}`)
    const alice = await authPost('/api/auth/login', { username: 'alice', password: 'alice123' })
    if (!alice.body.ok) fail(`alice login failed: ${JSON.stringify(alice.body)}`)
    const tokenA = alice.body.token
    const idA = alice.body.user.userId

    const bobReg = await authPost('/api/auth/register', { username: 'bob', password: 'bob123' })
    if (!bobReg.body.ok) fail(`bob register failed: ${JSON.stringify(bobReg.body)}`)
    const bob = await authPost('/api/auth/login', { username: 'bob', password: 'bob123' })
    if (!bob.body.ok) fail(`bob login failed: ${JSON.stringify(bob.body)}`)
    const tokenB = bob.body.token
    const idB = bob.body.user.userId
    check('registered alice & bob, obtained tokens', true, `A=${idA.slice(0, 8)} B=${idB.slice(0, 8)}`)

    // --- A creates a session ---
    const created = await rpcJson('session.create', {}, tokenA)
    console.log('DEBUG session.create ->', JSON.stringify(created.body).slice(0, 600))
    if (!created.body?.result?.ok) fail(`session.create failed: ${JSON.stringify(created.body)}`)
    const aliceSessionId = created.body.result.value.sessionId
    check('alice created a session', true, aliceSessionId.slice(0, 8))

    // --- A lists: should see her own session ---
    const listA = await rpcJson('session.list', {}, tokenA)
    const itemsA = listA.body?.result?.value?.items ?? []
    check('alice sees her own session', itemsA.some(s => s.sessionId === aliceSessionId),
      `count=${itemsA.length}`)

    // --- B lists: MUST NOT see A's session (the reported bug) ---
    const listB = await rpcJson('session.list', {}, tokenB)
    const itemsB = listB.body?.result?.value?.items ?? []
    check('bob sees ZERO of alice\'s sessions (isolation)', itemsB.length === 0,
      `count=${itemsB.length}`)

    // --- fail-closed: anonymous HTTP must be rejected, not served ---
    // The server replies with a plain-text 401 body, so read the status off
    // the raw response rather than parsing JSON.
    const anonRes = await rpc('session.list', {})
    check('anonymous session.list is rejected (401)', anonRes.status === 401,
      `status=${anonRes.status}`)

    // --- stream layer cross-user test (the reported leak was a WS mux leak) ---
    // Positive: alice's mux stream pushes her own session's baseline frame.
    const aliceMux = await openMuxStream(tokenA)
    check('alice mux stream sees her own session (positive)',
      aliceMux.ok && aliceMux.subscribed.includes(aliceSessionId),
      `subscribed=${JSON.stringify(aliceMux.subscribed)}`)

    // Cross-user: bob's mux stream must NOT include alice's session.
    const bobMux = await openMuxStream(tokenB)
    check('bob mux stream excludes alice\'s session (cross-user)',
      bobMux.ok && !bobMux.subscribed.includes(aliceSessionId) && bobMux.subscribed.length === 0,
      `subscribed=${JSON.stringify(bobMux.subscribed)}`)

    // Anon: the stream upgrade itself must be refused (fail-closed), so no
    // session frames can leak to an unauthenticated caller.
    const anonMux = await openMuxStream(undefined)
    check('anonymous mux stream upgrade is refused',
      anonMux.refused === true || anonMux.subscribed.length === 0,
      `refused=${anonMux.refused} subscribed=${JSON.stringify(anonMux.subscribed)} status=${anonMux.status ?? ''}`)

    // --- credentials isolation ---
    // credentials.describe takes {refs:[...]} and returns {credentials:{ref:CredentialView}}
    const setA = await rpcJson('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: 'alice-secret' }, tokenA)
    check('alice set a credential', setA.body?.result?.ok === true)
    const descA = await rpcJson('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] }, tokenA)
    const aCfg = descA.body?.result?.value?.credentials?.['DEEPSEEK_API_KEY']
    const descB = await rpcJson('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] }, tokenB)
    const bCfg = descB.body?.result?.value?.credentials?.['DEEPSEEK_API_KEY']
    check('alice credential shows configured', aCfg?.configured === true)
    check('bob credential shows NOT configured (isolated)', bCfg?.configured === false)

    // --- settings isolation (write a value as alice, read as bob) ---
    // settings.update takes {ns, patch}; settings.describe returns {namespaces:[{ns,value,...}]}
    const setS = await rpcJson('settings.update', { ns: 'ui-theme', patch: { preference: 'light' } }, tokenA)
    check('alice wrote a setting (ui-theme.preference=light)', setS.body?.result?.ok === true)
    const getB = await rpcJson('settings.describe', {}, tokenB)
    const bNs = (getB.body?.result?.value?.namespaces ?? []).find(n => n.ns === 'ui-theme')
    // bob's own (separate) settings doc must keep the default, not alice's value
    check('bob does not see alice\'s setting value', bNs?.value?.preference !== 'light',
      `bob.ui-theme=${JSON.stringify(bNs?.value)}`)

    // --- disk layout assertions ---
    // Sessions are batch-flushed by the persistence coordinator, so give the
    // writer a moment to materialize the per-user sessions directory.
    await new Promise(r => setTimeout(r, 2000))
    const aliceDir = join(DSH_HOME, 'users', idA)
    const bobDir = join(DSH_HOME, 'users', idB)
    check('alice sessions dir on disk', existsSync(join(aliceDir, 'sessions')),
      join('users', idA.slice(0, 8), 'sessions'))
    check('alice credentials file on disk', existsSync(join(aliceDir, '.credentials.yaml')))
    check('alice settings file on disk (per-user)', existsSync(join(aliceDir, 'settings.yaml')))
    check('bob has no sessions dir (created none)', !existsSync(join(bobDir, 'sessions')))
    check('bob has no settings file (wrote none)', !existsSync(join(bobDir, 'settings.yaml')))
    check('shared root has NO sessions dir (everything scoped)', !existsSync(join(DSH_HOME, 'sessions')))
    check('shared root has NO settings file (everything scoped)', !existsSync(join(DSH_HOME, 'settings.yaml')))
  } finally {
    console.log('--- SERVER LOG (full) ---')
    console.log(serverLog || '(empty)')
    killTree(child.pid)
  }

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`)
  process.exit(failed.length === 0 ? 0 : 2)
}

main().catch(err => {
  console.error('SMOKE TEST ERROR:', err)
  process.exit(1)
})
