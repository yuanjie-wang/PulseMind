/** Per-install identity (2026-11-05).
 *
 * Chrome and 360 load the SAME extension binary, so the protocol clientId is a
 * constant in both. The service replaces a connection with the same clientId
 * (close 4409) — which made two installs kick each other forever — and both
 * shared one conversation origin. `instance.ts` mints one id per browser
 * profile and persists it in chrome.storage.local, so the identity survives a
 * browser restart (the SW is short-lived) while a copied session scope still
 * reads as dead.
 *
 * The module keeps worker-lifetime state (`cached`, the mint chain), so every
 * case imports a fresh module copy via vi.resetModules(). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STORAGE_KEY = 'pulsemind.instanceId'

interface ChromeStub {
  bag: Record<string, unknown>
  calls: { get: number; set: number }
}

/** Minimal chrome.storage.local surface — the only API instance.ts touches. */
function installChrome(opts: { failGet?: boolean; failSet?: boolean; bag?: Record<string, unknown> } = {}): ChromeStub {
  const bag: Record<string, unknown> = { ...(opts.bag ?? {}) }
  const calls = { get: 0, set: 0 }
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          calls.get++
          if (opts.failGet) throw new Error('storage unavailable')
          return { [key]: bag[key] }
        },
        set: async (obj: Record<string, unknown>) => {
          calls.set++
          if (opts.failSet) throw new Error('quota exceeded')
          Object.assign(bag, obj)
        },
      },
    },
  }
  return { bag, calls }
}

/** Re-import the module with empty worker-lifetime state (a SW cold start). */
async function freshModule(): Promise<typeof import('../src/extension/background/instance')> {
  vi.resetModules()
  return import('../src/extension/background/instance')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('extension per-install instanceId', () => {
  it('mints a charset the server accepts and persists it under its own key', async () => {
    const chrome = installChrome()
    const { getInstanceId } = await freshModule()

    const id = await getInstanceId()
    // Shared with the server's sanitizer and the DB origin column.
    expect(id).toMatch(/^inst_[0-9a-f]{12}$/)
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(chrome.bag[STORAGE_KEY]).toBe(id)
    expect(chrome.calls.set).toBe(1)
  })

  it('reuses the stored id after a browser restart (local, not session storage)', async () => {
    const first = await freshModule()
    const chrome = installChrome()
    const id = await first.getInstanceId()
    expect(chrome.bag[STORAGE_KEY]).toBe(id)

    // SW terminated and woken: new module instance, same storage.
    const second = await freshModule()
    expect(await second.getInstanceId()).toBe(id)
    // Reading is enough — a stored valid id is never rewritten.
    expect(chrome.calls.set).toBe(1)
  })

  it('re-mints a malformed stored value instead of forwarding it', async () => {
    // A garbled/hand-edited value must never become an origin the server (or a
    // future version) cannot name.
    const chrome = installChrome({ bag: { [STORAGE_KEY]: 'bad id!' } })
    const { getInstanceId } = await freshModule()

    const id = await getInstanceId()
    expect(id).toMatch(/^inst_[0-9a-f]{12}$/)
    expect(id).not.toBe('bad id!')
    expect(chrome.bag[STORAGE_KEY]).toBe(id)
  })

  it('overlapping SW wake-ups share one mint (no id flip-flop on the same profile)', async () => {
    // A loser's id would be stamped on conversations the winner's connection
    // never lists — the tab-scope mint serializes for exactly this reason.
    const chrome = installChrome()
    const { getInstanceId } = await freshModule()

    const [a, b] = await Promise.all([getInstanceId(), getInstanceId()])
    expect(a).toBe(b)
    expect(chrome.calls.get).toBe(1)
    expect(chrome.calls.set).toBe(1)
  })

  it('storage failures fall back to an ephemeral identity for the worker lifetime', async () => {
    // Unreadable AND unwritable: the extension must still connect (the server
    // treats the id as best-effort), and the same worker must not mint a new
    // id per alarm — each new one would look like a different install.
    const chrome = installChrome({ failGet: true, failSet: true })
    const { getInstanceId } = await freshModule()

    const first = await getInstanceId()
    expect(first).toMatch(/^inst_[0-9a-f]{12}$/)
    expect(await getInstanceId()).toBe(first)
    expect(chrome.calls.get).toBe(1)
  })

  it('a failed mint does not poison the queue behind it', async () => {
    installChrome()
    const { getInstanceId } = await freshModule()

    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('entropy unavailable')
    })
    await expect(getInstanceId()).rejects.toThrow('entropy unavailable')
    spy.mockRestore()

    // The chain resolved its rejection: the next caller mints normally.
    await expect(getInstanceId()).resolves.toMatch(/^inst_[0-9a-f]{12}$/)
  })

  it('the service worker hands the minted id to the protocol client', () => {
    // Wiring scan: the module is only useful if hello carries it (the DB layer
    // and probes cover the server half; this is the extension half).
    const src = readFileSync(join(process.cwd(), 'src', 'extension', 'background', 'index.ts'), 'utf-8')
    expect(src).toMatch(/import \{ getInstanceId \} from '\.\/instance'/)
    expect(src).toMatch(/instanceId: await getInstanceId\(\)/)
  })
})
