import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import { HtmlArtifactCard, buildCardDocument, isHtmlFenceLang, hashText } from '../src/renderer/src/components/chat/HtmlArtifactCard'
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
