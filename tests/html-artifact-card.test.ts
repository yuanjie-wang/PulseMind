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

  it('strips a meta CSP off a fragment — it would kill the measure script too', () => {
    const frag = '<meta http-equiv="Content-Security-Policy" content=\'script-src "self"\'><p>x</p>'
    const doc = buildCardDocument(frag)
    expect(doc).not.toContain('Content-Security-Policy')
    expect(doc).toContain('<p>x</p>')
    expect(doc).toContain('pm-html-card-height')
  })

  it('injects the height reporter into a full document before </body>', () => {
    const page = '<!DOCTYPE html><html><head><title>p</title></head><body>hi</body></html>'
    const doc = buildCardDocument(page)
    expect(doc).toContain('pm-html-card-height')
    // The page's own markup is untouched — the reporter is the only edit, and
    // it lands inside the body.
    const head = page.slice(0, page.indexOf('</body>'))
    const tail = page.slice(page.indexOf('</body>'))
    expect(doc.startsWith(head)).toBe(true)
    expect(doc.endsWith(tail)).toBe(true)
    expect(doc.indexOf('pm-html-card-height')).toBeLessThan(doc.indexOf('</body>'))
  })

  it('a full document without </body> still gets the reporter (appended)', () => {
    const page = '<html lang="en">x'
    const doc = buildCardDocument(page)
    expect(doc.startsWith(page)).toBe(true)
    expect(doc).toContain('pm-html-card-height')
  })

  it('strips a meta CSP off full documents as well', () => {
    const page =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body>hi</body></html>'
    const doc = buildCardDocument(page)
    expect(doc).not.toContain('Content-Security-Policy')
    expect(doc).toContain('<body>hi<script>')
    expect(doc).toContain('pm-html-card-height')
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

  it('carries the preview/source tabs and the actions in the hover toolbar', () => {
    const html = renderCard('<h1>hi</h1>')
    // The toolbar (and every control in it) is always in the markup — CSS
    // hides it at rest, :hover reveals it. The chrome itself is pinned by the
    // wiring scans in html-card-wiring.test.ts.
    expect(html).toContain('pm-html-card')
    expect(html).toContain('pm-html-card-float')
    expect(html).toContain('pm-html-card-toolbar')
    expect(html).toContain('pm-html-card-body')
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

describe('artifact-card sandbox — one shared constant, panel actions trusted-only (full_20261011 X4/P0-3)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it('both cards consume HTML_ARTIFACT_SANDBOX; the hand-copied string is gone', () => {
    for (const [name, rel] of [
      ['desktop', '../src/renderer/src/components/chat/HtmlArtifactCard.tsx'],
      ['extension', '../src/extension/ui/HtmlArtifactCard.tsx'],
    ] as const) {
      const src = read(rel)
      expect(src, name).toContain('HTML_ARTIFACT_SANDBOX}')
      expect(src, name).not.toContain('sandbox="allow-scripts allow-popups')
    }
    // The other preview surfaces stay scripts-only (file previews, not
    // interactive exhibits) — pin THAT so a copy-paste from the card cannot
    // silently widen them either.
    for (const rel of [
      '../src/renderer/src/components/preview/HtmlPreview.tsx',
      '../src/renderer/src/components/tool-studio/ToolRunner.tsx',
      '../src/renderer/src/components/tool-studio/ToolWorkspace.tsx',
    ]) {
      expect(read(rel)).toContain('sandbox="allow-scripts"')
    }
  })

  it('the panel shadow root is CLOSED and the security actions check isTrusted', () => {
    const entry = read('../src/extension/content/index.tsx')
    expect(entry).toContain("attachShadow({ mode: 'closed' })")
    expect(entry).not.toContain("mode: 'open'")
    // Honest threat statement: DOM unreachable, events still cross.
    expect(entry).toContain('composed: true')
    for (const rel of [
      '../src/extension/ui/Composer.tsx',
      '../src/extension/ui/MessageBlocks.tsx',
      '../src/extension/ui/App.tsx',
    ]) {
      const src = read(rel)
      expect(src, rel).toContain('trustedOnly')
      // Every onClick on the guarded families must pass through the helper —
      // a raw onChangeApprovalMode/respondIteration/onApprovalResponse arrow
      // without the guard would reintroduce the synthetic-click hole.
      expect(src.match(/trustedOnly\(e\)/g)?.length).toBeGreaterThan(0)
    }
    expect(read('../src/extension/ui/trusted.ts')).toContain('isTrusted === true')
  })
})
