import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../src/renderer/src/agent/system-prompt-builder'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

// ── The state block's `## Current Page` section, two sources ────────────
//
// User ruling 2026-11-04: the desktop's OWN built-in browser page rides along
// with every turn — minimal information (title + URL), in the final state block,
// because the section is rebuilt on every tool-loop iteration and must not
// re-bill the cached prefix. Two sources feed it:
//   • `pageContext`    — a client pushed it (the browser extension sends its own
//                        tab with the message). Wins; reads with `page_*`.
//   • `pageContextProvider` — the desktop session's own app-view pane, pulled
//                        live at build time. Reads with the `browser` tool.
// The hint line branches on `source` because `page_*` does not exist in an
// app-pane session's toolset.

const opts = (patch: Partial<AgentEngineOptions> = {}): AgentEngineOptions => patch as AgentEngineOptions

const build = (patch: Partial<AgentEngineOptions> = {}) => buildSystemPrompt({ opts: opts(patch), messages: [], plan: null })

describe('Current Page — built-in browser (pulled live)', () => {
  it('renders title + URL and points at the `browser` tool, not `page_*`', async () => {
    const { stateBlock, systemPrompt } = await build({
      pageContextProvider: () => ({ url: 'https://example.com/docs', title: 'Example Docs', source: 'builtin' }),
    })
    expect(stateBlock).toContain('## Current Page')
    expect(stateBlock).toContain('- Title: Example Docs')
    expect(stateBlock).toContain('- URL: https://example.com/docs')
    expect(stateBlock).toContain('`browser` tool')
    expect(stateBlock).not.toContain('`page_*`')
    // Volatile state never enters the frozen prefix.
    expect(systemPrompt).not.toContain('## Current Page')
    expect(systemPrompt).not.toContain('https://example.com/docs')
  })

  it('consults the provider on every build — the agent may have navigated a pane tab', async () => {
    const urls = ['https://example.com/a', 'https://example.com/b']
    const provider = vi.fn(() => ({ url: urls.shift()!, title: 't', source: 'builtin' as const }))
    const first = await build({ pageContextProvider: provider })
    const second = await build({ pageContextProvider: provider })
    expect(first.stateBlock).toContain('https://example.com/a')
    expect(second.stateBlock).toContain('https://example.com/b')
    expect(provider).toHaveBeenCalledTimes(2)
  })
})

describe('Current Page — extension-pushed pageContext', () => {
  it('keeps the `page_*` hint for a source-less (extension) page', async () => {
    const { stateBlock } = await build({ pageContext: { url: 'https://shop.example/item/1', title: 'Item' } })
    expect(stateBlock).toContain('## Current Page')
    expect(stateBlock).toContain('https://shop.example/item/1')
    expect(stateBlock).toContain('`page_*`')
    expect(stateBlock).not.toContain('`browser` tool')
  })

  it('treats an explicit source=extension the same as the default', async () => {
    const { stateBlock } = await build({
      pageContext: { url: 'https://a.example/', title: 'A', source: 'extension' },
    })
    expect(stateBlock).toContain('`page_*`')
    expect(stateBlock).not.toContain('`browser` tool')
  })

  it('an explicit pageContext wins over the provider', async () => {
    const provider = vi.fn(() => ({ url: 'https://pane.example/', title: 'Pane', source: 'builtin' as const }))
    const { stateBlock } = await build({
      pageContext: { url: 'https://ext.example/', title: 'Ext' },
      pageContextProvider: provider,
    })
    expect(stateBlock).toContain('https://ext.example/')
    expect(stateBlock).not.toContain('https://pane.example/')
    expect(provider).not.toHaveBeenCalled()
  })
})

describe('Current Page — provider failures never reach the request', () => {
  it('a throwing provider means "no page"', async () => {
    const { stateBlock } = await build({
      pageContextProvider: () => {
        throw new Error('view destroyed')
      },
    })
    expect(stateBlock).not.toContain('## Current Page')
  })

  it('a null provider means "no page"', async () => {
    const { stateBlock } = await build({ pageContextProvider: () => null })
    expect(stateBlock).not.toContain('## Current Page')
  })

  it('a page with neither title nor URL renders nothing', async () => {
    const { stateBlock } = await build({ pageContextProvider: () => ({ source: 'builtin' }) })
    expect(stateBlock).not.toContain('## Current Page')
  })

  it('a URL-only page still renders (title optional)', async () => {
    const { stateBlock } = await build({
      pageContextProvider: () => ({ url: 'https://bare.example/', source: 'builtin' }),
    })
    expect(stateBlock).toContain('- URL: https://bare.example/')
    expect(stateBlock).not.toContain('- Title:')
  })
})

describe('Current Page — capped, because the block is rebuilt each iteration', () => {
  it('clips the title at 120 chars and the URL at 300', async () => {
    const title = 'x'.repeat(200)
    const url = `https://example.com/${'y'.repeat(400)}`
    const { stateBlock } = await build({ pageContextProvider: () => ({ url, title, source: 'builtin' }) })
    expect(stateBlock).toContain(`- Title: ${'x'.repeat(120)}…`)
    expect(stateBlock).not.toContain('x'.repeat(121))
    expect(stateBlock).toContain(`- URL: https://example.com/${'y'.repeat(300 - 'https://example.com/'.length)}…`)
    expect(stateBlock.length).toBeLessThan(1000)
  })
})

// ── Wiring — main side installs the puller on both option bags ──────────
//
// `updateOptions` replaces the option bag wholesale, so a provider attached only
// at construction would vanish on the first settings save / model switch and the
// section would silently stop appearing. Both call sites are load-bearing.

describe('Current Page — main-side wiring', () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8')

  it('session-manager attaches the provider at construction AND in refreshOptions', () => {
    const manager = src('src/main/agent/session-manager.ts')
    const hits = manager.match(/pageContextProvider: builtinPageContextProvider\(sessionId\)/g) ?? []
    expect(hits.length).toBe(2)
    expect(manager).toContain('browserService.currentPageOf(sessionId)')
  })

  it('BrowserService.currentPageOf guards destroyed views and fresh tabs, and never throws', () => {
    const browser = src('src/main/browser/BrowserService.ts')
    const start = browser.indexOf('currentPageOf(scope: string | null)')
    expect(start).toBeGreaterThan(-1)
    const body = browser.slice(start, browser.indexOf('\n  }\n', start))
    expect(body).toContain('isDestroyed()')
    expect(body).toContain('isFreshTabUrl(url)')
    expect(body).toContain('catch')
  })
})
