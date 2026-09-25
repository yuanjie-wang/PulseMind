import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import {
  HtmlArtifactCard,
  buildCardDocument,
  isHtmlFenceLang,
  hashText,
  persistHtmlCopy,
  toLocalFileUrl,
} from '../src/renderer/src/components/chat/HtmlArtifactCard'
import zh from '../src/renderer/src/i18n/locales/zh'
import en from '../src/renderer/src/i18n/locales/en'

vi.mock('../src/renderer/src/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/stores/previewPaneStore', () => ({ openInPreviewPane: vi.fn() }))

function renderCard(code: string, streaming = false): string {
  return renderToStaticMarkup(React.createElement(HtmlArtifactCard, { code, streaming }))
}

describe('isHtmlFenceLang', () => {
  it('accepts the fence language case-insensitively and ignores fence parameters', () => {
    expect(isHtmlFenceLang('html')).toBe(true)
    expect(isHtmlFenceLang('HTML')).toBe(true)
    expect(isHtmlFenceLang('html hl_lines=3')).toBe(true)
    expect(isHtmlFenceLang(' htm')).toBe(false)
    expect(isHtmlFenceLang('htmljs')).toBe(false)
    expect(isHtmlFenceLang(undefined)).toBe(false)
  })
})

describe('buildCardDocument', () => {
  it('wraps a fragment in the zero-margin shell with the height reporter', () => {
    const doc = buildCardDocument('<div class="k">对比</div>')
    expect(doc).toContain('<!doctype html>')
    expect(doc).toContain('<div class="k">对比</div>')
    expect(doc).toContain('pm-html-card-height')
  })

  it('keeps the hostile fragment verbatim — the sandbox is the sanitizer', () => {
    const frag = '<div onclick="steal()"><script>alert(1)</script></div>'
    expect(buildCardDocument(frag)).toContain(frag)
  })

  it('passes a full document through byte-identical, no injection', () => {
    const page = '<!DOCTYPE html><html><head><title>p</title></head><body>hi</body></html>'
    expect(buildCardDocument(page)).toBe(page)
    const page2 = '<html lang="en"><body>x</body></html>'
    expect(buildCardDocument(page2)).toBe(page2)
  })
})

describe('hashText', () => {
  it('is deterministic, input-sensitive and length-suffixed', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
    expect(hashText('abc')).toContain(`-${(3).toString(16)}`)
  })
})

describe('HtmlArtifactCard rendering', () => {
  it('renders an opaque-origin sandboxed iframe — never allow-same-origin', () => {
    const html = renderCard('<h1>hi</h1>')
    expect(html).toContain('sandbox="allow-scripts allow-popups allow-forms allow-modals"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('<iframe')
    // React's SSR prints the prop camel-cased (`srcDoc=`); the HTML attribute
    // is case-insensitive, so both spellings set srcdoc at runtime.
    expect(html).toMatch(/srcdoc=/i)
  })

  it('carries the preview/source tabs and the header actions', () => {
    const html = renderCard('<h1>hi</h1>')
    expect(html).toContain('htmlCard.title')
    expect(html).toContain('htmlCard.preview')
    expect(html).toContain('htmlCard.code')
    expect(html).toContain('htmlCard.copy')
    expect(html).toContain('htmlCard.openInBrowser')
    expect(html).toContain('htmlCard.openInPreview')
  })

  it('labels the stream while the fence is unterminated', () => {
    expect(renderCard('<h1>hi', true)).toContain('htmlCard.streaming')
    expect(renderCard('<h1>hi</h1>', false)).not.toContain('htmlCard.streaming')
  })
})

describe('htmlCard i18n keys', () => {
  const keys = ['title', 'streaming', 'preview', 'code', 'copy', 'copied', 'openInBrowser', 'openInPreview']
  it('exist in both locale dicts', () => {
    const zhCard = (zh as unknown as Record<string, Record<string, string>>).htmlCard
    const enCard = (en as unknown as Record<string, Record<string, string>>).htmlCard
    for (const k of keys) {
      expect(zhCard?.[k], `zh.htmlCard.${k}`).toBeTruthy()
      expect(enCard?.[k], `en.htmlCard.${k}`).toBeTruthy()
    }
  })
})

// The frame's serving path (review 2026-09-25 P1): a local-file: URL over a
// content-addressed tmp copy. node-env cannot mount the effect (no window, no
// layout), so the two helpers it composes are pinned here and the wiring is
// pinned as source — the shape that must never come back is a blob URL:
// blob: INHERITS the parent CSP (measured, scripts/probe-csp-inheritance.mjs)
// and would kill every inline script the model writes.
describe('persistHtmlCopy / toLocalFileUrl (the local-frame path)', () => {
  const g = globalThis as { window?: unknown }

  function stubApi(api: unknown): () => void {
    const hadWindow = 'window' in g
    const saved = g.window
    g.window = { ...((saved as object) ?? {}), electronAPI: api }
    return () => {
      if (hadWindow) g.window = saved
      else delete g.window
    }
  }

  it('writes content-addressed under tmp/html-cards and builds the local-file URL', async () => {
    const writes: Array<{ filePath: string; content: string }> = []
    const restore = stubApi({
      getDataPaths: async () => ({ dataDir: '/d' }),
      writeFile: async (input: { filePath: string; content: string }) => {
        writes.push(input)
        return { success: true }
      },
    })
    try {
      const p = await persistHtmlCopy('abc')
      expect(p).toBe(`/d/tmp/html-cards/${hashText('abc')}.html`)
      expect(await persistHtmlCopy('abc')).toBe(p) // same content → same path (no reload)
      expect(await persistHtmlCopy('abd')).not.toBe(p)
      expect(writes.map((w) => w.content)).toEqual(['abc', 'abc', 'abd'])

      expect(toLocalFileUrl('/d/tmp/html-cards/x.html')).toBe('local-file:///d/tmp/html-cards/x.html')
      // Windows: the drive letter rides the URL hostname (resolveLocalFilePath reads it back).
      expect(toLocalFileUrl('C:\\Users\\me\\x.html')).toBe('local-file://C:/Users/me/x.html')
    } finally {
      restore()
    }
  })

  it('returns null when the write fails or the bridge is absent', async () => {
    const restoreFail = stubApi({
      getDataPaths: async () => ({ dataDir: '/d' }),
      writeFile: async () => ({ success: false, error: 'denied' }),
    })
    try {
      expect(await persistHtmlCopy('abc')).toBeNull()
    } finally {
      restoreFail()
    }
    const restoreAbsent = stubApi(undefined)
    try {
      expect(await persistHtmlCopy('abc')).toBeNull() // no electronAPI at all → srcdoc fallback signal
    } finally {
      restoreAbsent()
    }
  })
})

describe('the serving path is local-file, never blob (source contract)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it('neither frame consumer mints a blob URL, and frame-src names local-file only', () => {
    const card = read('../src/renderer/src/components/chat/HtmlArtifactCard.tsx')
    const bridge = read('../src/renderer/src/tool-studio/bridge-host.ts')
    const indexHtml = read('../src/renderer/index.html')
    for (const [name, src] of [
      ['card', card],
      ['bridge-host', bridge],
    ] as const) {
      expect(src, `${name} must not use createObjectURL (blob inherits the CSP)`).not.toContain('createObjectURL')
      expect(src, `${name} must serve frames over local-file:`).toContain('local-file://')
    }
    expect(indexHtml).toContain('frame-src local-file:;')
    expect(indexHtml).not.toContain('frame-src local-file: blob:')
    // The CSP itself, not the comment above it (the comment SAYS the words).
    const csp = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
    expect(csp).toMatch(/script-src 'self'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })
})
