/** Welcome-notice state, durable when the browser may use Host settings. */

import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

/** State rendered by the welcome step. */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function acknowledgementOf(view: SettingsNamespaceView): string | undefined {
  if (typeof view.value !== 'object' || view.value === null) return undefined
  const value = (view.value as Record<string, unknown>)[WELCOME_NOTICE_ACK_FIELD]
  return typeof value === 'string' ? value : undefined
}

/**
 * Browser-local fallback for the acknowledgement.
 *
 * Remote browsers keep `settings` loopback-only, so they run this store in
 * memory mode. Memory state cannot survive a reload, and every login builds a
 * fresh store — so without a browser-local record the notice reopened on every
 * login and reload instead of once per copy version.
 */
export const LOCAL_ACK_KEY = 'dsh.ui-onboarding.welcomeNoticeVersion'

/** The storage surface this fallback needs, narrowed for testability. */
type AckStorage = Pick<Storage, 'getItem' | 'setItem'>

/** @returns web storage, or undefined where it is absent or blocked. */
function ackStorage(): AckStorage | undefined {
  try {
    return (globalThis as { localStorage?: AckStorage }).localStorage
  } catch {
    // Access itself throws in some sandboxed/SSR contexts.
    return undefined
  }
}

/** @returns the remembered copy version, or undefined when nothing was stored. */
function readLocalAck(): string | undefined {
  try {
    return ackStorage()?.getItem(LOCAL_ACK_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Remember the acknowledged version browser-locally; a no-op when unavailable. */
function writeLocalAck(version: string): void {
  try {
    ackStorage()?.setItem(LOCAL_ACK_KEY, version)
  } catch {
    /* Storage blocked (private mode): the acknowledgement stays process-local. */
  }
}

/** Coordinates durable Host acknowledgement or a process-local remote fallback. */
export class WelcomeNoticeStore {
  /** uSES-safe state source shared by the registered welcome step. */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore({
    status: 'idle', acknowledged: false, error: null,
  })

  private generation = 0

  /**
   * @param api - settings wire face used for durable reads and writes.
   * @param persistence - remote browsers use memory because settings is
   * loopback-only; that mode remembers the acknowledgement in web storage so a
   * reload or a later login does not reopen an already-dismissed notice.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {}

  /** Load the acknowledgement from Host settings or initialize process-local state. */
  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.persistence === 'memory') {
      const remembered = readLocalAck()
      this.store.update((state) => {
        state.status = 'ready'
        // Only a stored value decides. Absent storage must not erase an
        // acknowledgement this process already recorded: the store instance
        // outlives a single load, and a browser without storage would
        // otherwise reopen the notice on every refresh of the same page.
        if (remembered !== undefined) state.acknowledged = remembered === WELCOME_NOTICE_VERSION
        state.error = null
      })
      return
    }
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await this.api.settings.describe({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const view = response.result.value.namespaces.find(
        candidate => candidate.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE,
      )
      if (view === undefined) throw new Error('welcome acknowledgement settings are unavailable')
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = acknowledgementOf(view) === WELCOME_NOTICE_VERSION
        state.error = null
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.acknowledged = false
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Persist this copy version, or advance only this process for a remote browser.
   * @returns true when the selected persistence mode accepted the acknowledgement.
   */
  async acknowledge(): Promise<boolean> {
    const generation = ++this.generation
    if (this.persistence === 'memory') {
      // Make the dismissal stick across reloads and later logins in this
      // browser; Host settings stay untouched because they are unreachable here.
      writeLocalAck(WELCOME_NOTICE_VERSION)
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = true
        state.error = null
      })
      return true
    }
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      const response = await this.api.settings.mutate({
        ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION }],
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (generation === this.generation) {
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = true
          state.error = null
        })
      }
      return true
    } catch (error) {
      if (generation === this.generation) {
        this.store.update((state) => {
          state.status = 'error'
          state.acknowledged = false
          state.error = messageOf(error)
        })
      }
      return false
    }
  }
}

/**
 * Refresh only after welcome state has left idle. A memory-mode load retains
 * acknowledgement so reconnect does not reopen a process-local notice.
 * @param controller - welcome state owner whose current status decides whether to load.
 */
export function refreshWelcomeIfLoaded(controller: WelcomeNoticeStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}
