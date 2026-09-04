import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { LOCAL_ACK_KEY, refreshWelcomeIfLoaded, WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

let rpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `welcome-${rpc++}` as never, result: { ok: true, value } }
}

function namespace(version?: string) {
  return {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    schema: {},
    value: version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version },
    base: {},
    user: {},
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** @returns web storage when this environment provides one. */
function webStorage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage
}

/**
 * Install an in-memory Storage stand-in so memory-mode persistence is testable
 * in environments that ship no DOM storage.
 * @param initial - entries to seed.
 * @returns a disposer restoring the original global.
 */
function installLocalStorage(initial: Record<string, string> = {}): () => void {
  const entries = new Map(Object.entries(initial))
  const stub = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
    clear: () => { entries.clear() },
    key: () => null,
    length: 0,
  } as unknown as Storage
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: stub })
  return () => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', original)
  }
}

beforeEach(() => {
  // Memory mode remembers the dismissal in web storage; keep every case
  // independent of what an earlier case acknowledged.
  webStorage()?.clear()
})

describe('WelcomeNoticeStore', () => {
  it('acknowledges in memory without calling loopback-only settings APIs', async () => {
    const describe = vi.fn()
    const mutate = vi.fn()
    const controller = new WelcomeNoticeStore({ settings: { describe, mutate } } as never, 'memory')

    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: false, error: null })
    await expect(controller.acknowledge()).resolves.toBe(true)
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    expect(describe).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('survives a reload: a fresh memory-mode store keeps the dismissal', async () => {
    // Regression: each login builds a new store, and process-local state could
    // not survive it, so the notice reopened on every login and reload.
    const dispose = installLocalStorage()
    try {
      const api = { settings: { describe: vi.fn(), mutate: vi.fn() } }
      const before = new WelcomeNoticeStore(api as never, 'memory')
      await before.load()
      expect(before.store.getSnapshot().acknowledged).toBe(false)
      await expect(before.acknowledge()).resolves.toBe(true)

      const after = new WelcomeNoticeStore(api as never, 'memory')
      await after.load()
      expect(after.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
      expect(api.settings.describe).not.toHaveBeenCalled()
      expect(api.settings.mutate).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('reopens the memory-mode notice when the stored copy version is older', async () => {
    const dispose = installLocalStorage({ [LOCAL_ACK_KEY]: 'older-copy' })
    try {
      const controller = new WelcomeNoticeStore({
        settings: { describe: vi.fn(), mutate: vi.fn() },
      } as never, 'memory')
      await controller.load()
      expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: false, error: null })
    } finally {
      dispose()
    }
  })

  it('degrades to process-local acknowledgement when web storage is blocked', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage blocked') },
    })
    try {
      const controller = new WelcomeNoticeStore({
        settings: { describe: vi.fn(), mutate: vi.fn() },
      } as never, 'memory')
      await controller.load()
      expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: false, error: null })
      await expect(controller.acknowledge()).resolves.toBe(true)
      // Still retained in-process: blocked storage must not reopen the notice
      // on the next load of the same page.
      await controller.load()
      expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
      else Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  it('ignores web-storage read and write failures in memory mode', async () => {
    // Private-mode storage exists but rejects every access; containment must
    // keep the notice flow working off process-local state alone.
    const throwing = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: throwing })
    try {
      const controller = new WelcomeNoticeStore({
        settings: { describe: vi.fn(), mutate: vi.fn() },
      } as never, 'memory')
      await controller.load()
      expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: false, error: null })
      await expect(controller.acknowledge()).resolves.toBe(true)
      await controller.load()
      expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
      else Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  it('acknowledges only the exact current copy version', async () => {
    for (const [version, acknowledged] of [
      [undefined, false],
      ['older-copy', false],
      [WELCOME_NOTICE_VERSION, true],
    ] as const) {
      const api = {
        settings: {
          describe: vi.fn(() => Promise.resolve(ok({
            writable: true, hasDocument: false, namespaces: [namespace(version)],
          }))),
        },
      }
      const controller = new WelcomeNoticeStore(api as never)
      await controller.load()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged })
    }
  })

  it('persists the owner version through one idempotent path mutation', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(namespace(WELCOME_NOTICE_VERSION))))
    const controller = new WelcomeNoticeStore({ settings: { mutate } } as never)
    await expect(controller.acknowledge()).resolves.toBe(true)
    expect(mutate).toHaveBeenCalledWith({
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION }],
    })
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
  })

  it('keeps the notice pending when loading or persistence fails', async () => {
    const load = new WelcomeNoticeStore({
      settings: { describe: () => Promise.reject(new Error('offline')) },
    } as never)
    await load.load()
    expect(load.store.getSnapshot()).toEqual({ status: 'error', acknowledged: false, error: 'offline' })

    const save = new WelcomeNoticeStore({
      settings: { mutate: () => Promise.reject(new Error('disk full')) },
    } as never)
    await expect(save.acknowledge()).resolves.toBe(false)
    expect(save.store.getSnapshot()).toEqual({ status: 'error', acknowledged: false, error: 'disk full' })

    const nonError = new WelcomeNoticeStore({
      // Durable/wire failures are unknown; exercise containment of a non-Error rejection.
      settings: { describe: () => Promise.reject(new Error('offline string')) },
    } as never)
    await nonError.load()
    expect(nonError.store.getSnapshot().error).toBe('offline string')
  })

  it('reports business failures, missing namespaces, and malformed durable values', async () => {
    for (const describe of [
      () => Promise.resolve({
        rpcId: 'failed' as never,
        result: { ok: false as const, error: { code: 'internal' as const, message: 'denied', details: {} } },
      }),
      () => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [] })),
    ]) {
      const controller = new WelcomeNoticeStore({ settings: { describe } } as never)
      await controller.load()
      expect(controller.store.getSnapshot().status).toBe('error')
    }

    for (const value of [null, 42, { [WELCOME_NOTICE_ACK_FIELD]: 42 }]) {
      const controller = new WelcomeNoticeStore({
        settings: { describe: () => Promise.resolve(ok({
          writable: true,
          hasDocument: false,
          namespaces: [{ ...namespace(), value }],
        })) },
      } as never)
      await controller.load()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    }

    const save = new WelcomeNoticeStore({
      settings: { mutate: () => Promise.resolve({
        rpcId: 'failed-save' as never,
        result: {
          ok: false,
          error: {
            code: 'settings-rejected',
            message: 'denied',
            details: { ns: WELCOME_NOTICE_SETTINGS_NAMESPACE },
          },
        },
      }) },
    } as never)
    await expect(save.acknowledge()).resolves.toBe(false)
    expect(save.store.getSnapshot().error).toBe('denied')
  })

  it('lets the latest load win over stale success and failure', async () => {
    const first = deferred<ReturnType<typeof ok>>()
    const describe = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [namespace()],
      })))
    const controller = new WelcomeNoticeStore({ settings: { describe } } as never)
    const stale = controller.load()
    await controller.load()
    first.resolve(ok({
      writable: true, hasDocument: false, namespaces: [namespace(WELCOME_NOTICE_VERSION)],
    }))
    await stale
    expect(controller.store.getSnapshot().acknowledged).toBe(false)

    const failed = deferred<ReturnType<typeof ok>>()
    describe
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [namespace(WELCOME_NOTICE_VERSION)],
      })))
    const staleFailure = controller.load()
    await controller.load()
    failed.reject('stale failure')
    await staleFailure
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true, error: null })
  })

  it('contains stale acknowledgement settlements and refreshes only a loaded store', async () => {
    const write = deferred<ReturnType<typeof ok>>()
    const describe = vi.fn(() => Promise.resolve(ok({
      writable: true, hasDocument: false, namespaces: [namespace()],
    })))
    const controller = new WelcomeNoticeStore({
      settings: { mutate: () => write.promise, describe },
    } as never)
    refreshWelcomeIfLoaded(controller)
    expect(describe).not.toHaveBeenCalled()
    const staleWrite = controller.acknowledge()
    await controller.load()
    write.resolve(ok(namespace(WELCOME_NOTICE_VERSION)))
    await expect(staleWrite).resolves.toBe(true)
    expect(controller.store.getSnapshot().acknowledged).toBe(false)
    refreshWelcomeIfLoaded(controller)
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })

    const failedWrite = deferred<ReturnType<typeof ok>>()
    const staleFailure = new WelcomeNoticeStore({
      settings: { mutate: () => failedWrite.promise, describe },
    } as never)
    const pending = staleFailure.acknowledge()
    await staleFailure.load()
    failedWrite.reject('late failure')
    await expect(pending).resolves.toBe(false)
    expect(staleFailure.store.getSnapshot().status).toBe('ready')
  })
})
