#!/usr/bin/env node
/**
 * Migrate pre-isolation (shared-root) DeepSeek Harness data under ~/.dsh into the
 * Plan A per-user layout ~/.dsh/users/<id>/.
 *
 * Before user isolation, sessions / settings / credentials lived at the shared
 * harness home root (~/.dsh/sessions, ~/.dsh/settings.yaml,
 * ~/.dsh/.credentials.yaml). With Plan A isolation enabled (userScope: true on
 * the session-persistence-jsonl, settings-file, and credentials-local rows), each
 * authenticated account reads/writes under ~/.dsh/users/<id>/ instead. Data left
 * at the shared root becomes invisible to every account. This script moves that
 * legacy data under one chosen account.
 *
 * Usage:
 *   node scripts/migrate-to-user-scoped-home.mjs --first
 *   node scripts/migrate-to-user-scoped-home.mjs --user <uuid>
 *   node scripts/migrate-to-user-scoped-home.mjs --home /path/to/.dsh --first --dry-run
 *
 * Notes:
 *   - The target account must already exist in ~/.dsh/users/auth-users.json.
 *   - Idempotent: an artifact already present under the target user is skipped
 *     (never overwritten or merged). Run once per target account.
 *   - Never moves ~/.dsh/users/* itself (auth store + signing secret stay put).
 */

import { homedir } from 'node:os'
import { existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEFAULT_HOME = join(homedir(), '.dsh')

function resolveDshHome(arg) {
  if (arg) return resolve(arg)
  const env = process.env.DSH_HOME
  if (env && env.trim().length > 0) return resolve(env.trim())
  return DEFAULT_HOME
}

function printHelp() {
  console.log(`migrate-to-user-scoped-home [--home <path>] (--user <id> | --first) [--dry-run]

  --home <path>   Harness home to migrate (default: $DSH_HOME or ~/.dsh)
  --user <id>     Target account id (the userId from /api/auth/me)
  --first         Use the first registered account in auth-users.json
  --dry-run       Print moves without performing them
  -h, --help      Show this help`)
}

function parseArgs(argv) {
  const args = { home: undefined, user: undefined, first: false, dryRun: false, help: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--home') args.home = argv[++i]
    else if (a === '--user') args.user = argv[++i]
    else if (a === '--first') args.first = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') args.help = true
    else { console.error(`unknown argument: ${a}`); process.exit(2) }
  }
  return args
}

function firstAuthUserId(home) {
  const file = join(home, 'users', 'auth-users.json')
  if (!existsSync(file)) return undefined
  try {
    const arr = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(arr) && arr.length > 0 && arr[0].userId) return arr[0].userId
  } catch { /* ignore corrupt file */ }
  return undefined
}

function main() {
  const { home, user: userArg, first, dryRun, help } = parseArgs(process.argv)
  if (help) { printHelp(); process.exit(0) }

  const dshHome = resolveDshHome(home)
  if (!existsSync(dshHome)) {
    console.error(`DSH home not found: ${dshHome}`)
    process.exit(1)
  }

  let targetId = userArg
  if (!targetId && first) targetId = firstAuthUserId(dshHome)
  if (!targetId) {
    console.error('Specify the target account: --user <id> or --first (first registered account).')
    process.exit(2)
  }

  const usersDir = join(dshHome, 'users')
  if (!existsSync(usersDir)) mkdirSync(usersDir, { recursive: true })
  const targetDir = join(usersDir, targetId)
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

  const artifacts = [
    { name: 'sessions', note: 'conversation logs' },
    { name: 'settings.yaml', note: 'user settings' },
    { name: '.credentials.yaml', note: 'managed credentials' },
  ]

  let moved = 0
  let skipped = 0
  for (const art of artifacts) {
    const src = join(dshHome, art.name)
    const dst = join(targetDir, art.name)
    if (!existsSync(src)) { console.log(`skip   (absent)        ${art.name} — ${art.note}`); skipped++; continue }
    if (existsSync(dst)) { console.log(`skip   (target exists) ${art.name} — ${art.note}`); skipped++; continue }
    if (dryRun) { console.log(`plan   ${art.name} -> users/${targetId}/${art.name}`); moved++; continue }
    try {
      renameSync(src, dst)
      console.log(`moved  ${art.name} -> users/${targetId}/${art.name}`)
      moved++
    } catch (error) {
      console.error(`FAILED ${art.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`\n${dryRun ? 'Would migrate' : 'Migrated'} ${moved} artifact(s); ${skipped} skipped.`)
  console.log(`Target account: ${targetId}`)
  if (moved > 0 && !dryRun) {
    console.log('Restart dsh web for the change to take effect.')
  }
}

main()
