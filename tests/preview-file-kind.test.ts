import { describe, it, expect } from 'vitest'
import { baseName, extensionOf, detectFileKind, isPreviewable, shouldAutoOpen, resolvePreviewPath } from '../src/shared/preview/file-kind'

describe('baseName / extensionOf', () => {
  it('handles both separators and strips query/hash', () => {
    expect(baseName('/a/b/c/report.md')).toBe('report.md')
    expect(baseName('C:\\a\\b\\c\\report.md')).toBe('report.md')
    expect(baseName('/a/b/data.csv?x=1#frag')).toBe('data.csv')
  })

  it('extension is lowercased; dotfiles have no extension', () => {
    expect(extensionOf('/x/Photo.JPG')).toBe('jpg')
    expect(extensionOf('/x/.env')).toBe('')
    expect(extensionOf('/x/noext')).toBe('')
  })
})

describe('detectFileKind', () => {
  it('maps the v1 previewable kinds', () => {
    expect(detectFileKind('a/b.md')).toBe('markdown')
    expect(detectFileKind('a/b.markdown')).toBe('markdown')
    expect(detectFileKind('a/b.ts')).toBe('text')
    expect(detectFileKind('a/b.json')).toBe('text')
    expect(detectFileKind('a/b.txt')).toBe('text')
    expect(detectFileKind('a/b.png')).toBe('image')
    expect(detectFileKind('a/b.html')).toBe('html')
    expect(detectFileKind('a/b.csv')).toBe('csv')
    expect(detectFileKind('a/b.tsv')).toBe('csv')
  })

  it('maps office and unknown to non-previewable kinds', () => {
    expect(detectFileKind('a/b.docx')).toBe('office')
    expect(detectFileKind('a/b.pptx')).toBe('office')
    expect(detectFileKind('a/b.pdf')).toBe('office')
    expect(detectFileKind('a/b.xyz')).toBe('binary')
    expect(detectFileKind('a/noext')).toBe('binary')
  })

  it('recognizes well-known extension-less filenames as text', () => {
    expect(detectFileKind('repo/Makefile')).toBe('text')
    expect(detectFileKind('repo/Dockerfile')).toBe('text')
    expect(detectFileKind('repo/.gitignore')).toBe('text')
  })
})

describe('isPreviewable / shouldAutoOpen', () => {
  it('accepts exactly the v1 kinds', () => {
    expect(isPreviewable('markdown')).toBe(true)
    expect(isPreviewable('text')).toBe(true)
    expect(isPreviewable('image')).toBe(true)
    expect(isPreviewable('html')).toBe(true)
    expect(isPreviewable('csv')).toBe(true)
    expect(isPreviewable('office')).toBe(false)
    expect(isPreviewable('binary')).toBe(false)
  })

  it('auto-open follows previewability (D3)', () => {
    expect(shouldAutoOpen('/w/report.md')).toBe(true)
    expect(shouldAutoOpen('/w/chart.png')).toBe(true)
    expect(shouldAutoOpen('/w/data.xlsx')).toBe(false)
    expect(shouldAutoOpen('/w/thing.bin')).toBe(false)
  })
})

describe('resolvePreviewPath', () => {
  const ws = '/Users/u/.pulsemind/workspace/20260914120000'

  it('passes through absolute / drive-letter / ~ paths', () => {
    expect(resolvePreviewPath('/abs/x.md', ws)).toBe('/abs/x.md')
    expect(resolvePreviewPath('C:\\abs\\x.md', ws)).toBe('C:\\abs\\x.md')
    expect(resolvePreviewPath('~/x.md', ws)).toBe('~/x.md')
  })

  it('joins relative paths onto the workspace, trimming extra slashes', () => {
    expect(resolvePreviewPath('report.md', ws)).toBe(`${ws}/report.md`)
    expect(resolvePreviewPath('a/b.md', `${ws}/`)).toBe(`${ws}/a/b.md`)
    // Leading "/" is ABSOLUTE — same semantics as the executor's
    // resolveWorkspacePath (tool-executors.ts), not workspace-relative.
    expect(resolvePreviewPath('/lead.md', ws)).toBe('/lead.md')
  })

  it('tolerates missing workspace and blank input', () => {
    expect(resolvePreviewPath('rel.md', null)).toBe('rel.md')
    expect(resolvePreviewPath('rel.md', undefined)).toBe('rel.md')
    expect(resolvePreviewPath('', ws)).toBe('')
  })
})
