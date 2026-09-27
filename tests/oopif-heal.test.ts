// OOPIF blindness heal (app-view reconnect).
//
// The mechanism this pins: Playwright's connectOverCDP never adopts Electron
// frame targets that predate the connection, so a tab that survived a
// reconnect cannot see or act inside its cross-origin iframes (snapshot
// omits the content, aria-ref actions time out). The heal reloads proven-
// blind pages — Electron's frame list vs Playwright's — because a reload
// re-births the frame targets into the live auto-attach. The live behavior
// (blind → reload → controllable) is pinned by scripts/probe-appview-oopif.mjs
// on a real Electron + real CDP stack; this file pins the decision logic and
// the wiring, which is all vitest can see.

import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { healOopifBlindPage, missingFrameUrls } from '../src/main/browser/oopif-heal'

const APPVIEW = join(fileURLToPath(new URL('.', import.meta.url)), '../src/main/browser/backends/AppViewBackend.ts')
const read = (p: string) => readFileSync(p, 'utf-8')

describe('missingFrameUrls — the blindness decision', () => {
  it('reports Electron frames Playwright does not know', () => {
    expect(
      missingFrameUrls(
        ['http://localhost:1/parent', 'http://127.0.0.1:1/child'],
        ['http://localhost:1/parent'],
      ),
    ).toEqual(['http://127.0.0.1:1/child'])
  })

  it('is empty when Playwright sees every frame', () => {
    const urls = ['http://localhost:1/parent', 'http://127.0.0.1:1/child']
    expect(missingFrameUrls(urls, [...urls])).toEqual([])
  })

  it('ignores about:blank on both sides (fresh frames, fresh tabs are noise)', () => {
    expect(missingFrameUrls(['about:blank', 'http://a/'], ['about:blank'])).toEqual(['http://a/'])
    expect(missingFrameUrls(['about:blank'], ['about:blank', 'http://a/'])).toEqual([])
  })

  it('returns [] (not a blind reload) for a fresh tab Electron sees as bare', () => {
    expect(missingFrameUrls([], [])).toEqual([])
  })
})

interface FakeFrame {
  url: string
}

function fakePage(frames: FakeFrame[], opts?: { framesThrows?: boolean; reloadFails?: boolean }) {
  const reload = vi.fn(async () => {
    if (opts?.reloadFails) throw new Error('net::ERR_ABORTED')
  })
  const page = {
    // playwright-core's Frame.url is a METHOD — the heal calls it; a fake that
    // exposed it as a property would bless exactly the bug this pins against.
    frames: () => {
      if (opts?.framesThrows) throw new Error('Target closed')
      return frames.map((f) => ({ url: () => f.url })) as never
    },
    reload,
  }
  return { page: page as never, reload }
}

describe('healOopifBlindPage — reload only proven-blind pages', () => {
  it('reloads and reports true when a frame is missing', async () => {
    const { page, reload } = fakePage([{ url: 'http://localhost:1/parent' }])
    const healed = await healOopifBlindPage(page, ['http://localhost:1/parent', 'http://127.0.0.1:1/child'])
    expect(healed).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not touch a page whose frames are all known', async () => {
    const { page, reload } = fakePage([{ url: 'http://localhost:1/parent' }, { url: 'http://127.0.0.1:1/child' }])
    const healed = await healOopifBlindPage(page, ['http://localhost:1/parent', 'http://127.0.0.1:1/child'])
    expect(healed).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('a frames() failure (page gone) reads as nothing-to-heal, no reload', async () => {
    const { page, reload } = fakePage([], { framesThrows: true })
    const healed = await healOopifBlindPage(page, ['http://127.0.0.1:1/child'])
    expect(healed).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('a failed reload reports false rather than throwing', async () => {
    const { page, reload } = fakePage([{ url: 'http://localhost:1/parent' }], { reloadFails: true })
    const healed = await healOopifBlindPage(page, ['http://localhost:1/parent', 'http://127.0.0.1:1/child'])
    expect(healed).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('wiring — AppViewBackend heals surviving views on reconnect', () => {
  it('imports the heal and runs it only when views survived into start()', () => {
    const src = read(APPVIEW)
    expect(src.includes("from '../oopif-heal'")).toBe(true)
    // the reconnect discriminator: every view is created AFTER a start(), so a
    // non-empty map at start() time is exactly "the previous connection died"
    expect(src.includes('if (this.views.size > 0) await this.healAdoptedViews()')).toBe(true)
  })

  it('healAdoptedViews matches views to pages by a transient tag and feeds Electron frame URLs', () => {
    const src = read(APPVIEW)
    // the newTab marker dies at the tab's first navigation, so matching
    // writes a fresh tag from the Electron side and reads it back
    expect(src.includes('window.__pmHealTag = ${JSON.stringify(tag)}')).toBe(true)
    expect(src.includes("candidate.evaluate('window.__pmHealTag')")).toBe(true)
    expect(src.includes('wc.mainFrame.frames.map((f) => f.url)')).toBe(true)
    expect(src.includes('healOopifBlindPage(page, frameUrls)')).toBe(true)
  })
})

// existsSync guard so a moved file fails with a clear message, not ENOENT
it('the backend module is where the wiring scan looks', () => {
  expect(existsSync(APPVIEW)).toBe(true)
})
