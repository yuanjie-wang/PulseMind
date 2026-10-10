import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { localFileUrl } from '../src/shared/preview/local-file-url'

// ── full_20261011 M3-P1-2/X1: the renderer pasted RAW paths into
// local-file:// URLs. `%` hit the serve side's fail-closed traversal gate
// (decodeURIComponent throws → 403) and `#` cut the tail into the URL
// fragment (reading a DIFFERENT path). One constructor encodes; the gate's
// "malformed %-sequence never comes from our own renderer" premise holds now.

describe('localFileUrl', () => {
  it('encodes %, # and spaces but keeps /, : and the drive letter', () => {
    expect(localFileUrl('/Users/me/50% off.png')).toBe('local-file:///Users/me/50%25%20off.png')
    expect(localFileUrl('/Users/me/report #1.html')).toBe('local-file:///Users/me/report%20%231.html')
    expect(localFileUrl('C:\\Users\\me\\a b.png')).toBe('local-file://C:/Users/me/a%20b.png')
    expect(localFileUrl('/plain/path.md')).toBe('local-file:///plain/path.md')
  })

  it('appends the preview query after the encoded path', () => {
    expect(localFileUrl('/a%20b.html', 'pmPreview=1')).toBe('local-file:///a%2520b.html?pmPreview=1')
  })

  it('the produced URL survives new URL(...).pathname round-trip (what the serve side reads)', () => {
    const u = new URL(localFileUrl('/Users/me/50% off.png'))
    expect(decodeURIComponent(u.pathname)).toBe('/Users/me/50% off.png')
  })
})

describe('wiring — every local-file:// producer goes through the constructor', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it('no raw template-literal production remains in the renderer', () => {
    for (const rel of [
      '../src/renderer/src/components/preview/HtmlPreview.tsx',
      '../src/renderer/src/components/preview/ImagePreview.tsx',
      '../src/renderer/src/components/chat/LocalImage.tsx',
      '../src/renderer/src/components/chat/HtmlArtifactCard.tsx',
    ]) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/`local-file:\/\/\$\{/)
      expect(src, rel).not.toMatch(/'local-file:\/\/' \+/)
    }
  })
})
