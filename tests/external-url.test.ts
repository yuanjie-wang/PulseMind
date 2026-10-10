// openExternal scheme gate (review 2026-09-25 item 2): shell.openExternal
// hands a URL to the OS launcher, so an arbitrary scheme means smb:// shares,
// custom app protocols, javascript:/data: and file:///x.command. The policy
// is a pure function (dataDir is a parameter) — every main-side openExternal
// call funnels through it.
import { describe, expect, it } from 'vitest'
import { safeOpenPath } from '../src/main/utils/external-url'
import { safeExternalUrl } from '../src/main/utils/external-url'

const DATA_DIR = '/Users/u/.pulsemind'

describe('safeExternalUrl — scheme allow-list', () => {
  it('opens the ordinary link schemes', () => {
    expect(safeExternalUrl('https://example.com/a?b=1#c', DATA_DIR)).toBe('https://example.com/a?b=1#c')
    expect(safeExternalUrl('http://example.com', DATA_DIR)).toBe('http://example.com/')
    expect(safeExternalUrl('mailto:someone@example.com', DATA_DIR)).toBe('mailto:someone@example.com')
    expect(safeExternalUrl('chrome://extensions', DATA_DIR)).toBe('chrome://extensions')
  })

  it('refuses every other scheme', () => {
    const denied = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'smb://fileserver/share',
      'ftp://files.example.com/pub',
      'file://fileserver/share', // UNC-style file URL outside dataDir
      'app:com.example.malicious',
      'ws://127.0.0.1:8765',
    ]
    for (const url of denied) expect(safeExternalUrl(url, DATA_DIR), url).toBeNull()
  })

  it('refuses junk', () => {
    expect(safeExternalUrl('', DATA_DIR)).toBeNull()
    expect(safeExternalUrl('   ', DATA_DIR)).toBeNull()
    expect(safeExternalUrl('not a url', DATA_DIR)).toBeNull()
    expect(safeExternalUrl('example.com', DATA_DIR)).toBeNull() // no scheme
    expect(safeExternalUrl(42 as unknown as string, DATA_DIR)).toBeNull()
    expect(safeExternalUrl(null as unknown as string, DATA_DIR)).toBeNull()
    expect(safeExternalUrl(undefined as unknown as string, DATA_DIR)).toBeNull()
  })
})

describe('safeExternalUrl — file: is jailed to dataDir', () => {
  it('opens app-managed files inside dataDir', () => {
    expect(safeExternalUrl(`file://${DATA_DIR}/tmp/html-cards/card.html`, DATA_DIR)).toBe(
      `file://${DATA_DIR}/tmp/html-cards/card.html`,
    )
    // dataDir itself counts as inside. (A non-empty path keeps its exact href
    // — unlike http, the serializer does not append a trailing slash.)
    expect(safeExternalUrl(`file://${DATA_DIR}`, DATA_DIR)).toBe(`file://${DATA_DIR}`)
  })

  it('refuses paths outside dataDir, including traversal', () => {
    const denied = [
      'file:///etc/passwd',
      'file:///Users/u/.ssh/id_rsa',
      // The URL parser does NOT collapse a literal '..' after a dot-prefixed
      // segment on Node 20 (`/Users/u/.pulsemind/../../…` survives intact), so
      // the gate resolves the dots itself before the prefix check — this is
      // the case that caught the naive-prefix-check bypass.
      `file://${DATA_DIR}/../../.ssh/id_rsa`,
      `file://${DATA_DIR}/%2e%2e/evil.html`, // percent-encoded dots decode before resolution
      'file:///.pulsemind/../.ssh/id_rsa', // shorthand + traversal
      `file://${DATA_DIR}/x/..%2f..%2f..%2fetc/passwd`, // encoded slash decodes into a traversal
      'file:///.ssh/id_rsa', // shorthand only maps /.pulsemind/
    ]
    for (const url of denied) expect(safeExternalUrl(url, DATA_DIR), url).toBeNull()
  })

  it('refuses launchable extensions even inside dataDir', () => {
    const denied = [
      `file://${DATA_DIR}/tmp/run.command`, // macOS LaunchServices executes
      `file://${DATA_DIR}/tmp/run.EXE`, // extension check is case-insensitive
      `file://${DATA_DIR}/tmp/payload.js`,
      `file://${DATA_DIR}/tmp/installer.pkg`,
      `file://${DATA_DIR}/tmp/note.command%00.html`, // NUL truncation on Win32 — refused outright
    ]
    for (const url of denied) expect(safeExternalUrl(url, DATA_DIR), url).toBeNull()
    // The inverse: inert content is fine.
    expect(safeExternalUrl(`file://${DATA_DIR}/tmp/report.html`, DATA_DIR)).not.toBeNull()
    expect(safeExternalUrl(`file://${DATA_DIR}/tmp/readme.md`, DATA_DIR)).not.toBeNull()
  })

  it('maps the file:///.pulsemind/ shorthand onto dataDir', () => {
    expect(safeExternalUrl('file:///.pulsemind/tmp/html-cards/card.html', DATA_DIR)).toBe(
      'file:///.pulsemind/tmp/html-cards/card.html',
    )
    // A file whose name merely starts with the exec extension's prefix is fine.
    expect(safeExternalUrl(`file://${DATA_DIR}/tmp/notcommand`, DATA_DIR)).not.toBeNull()
  })
})

describe('safeOpenPath — openPath never launches an executable (full_20261011 M8-F4)', () => {
  it('denies launchable extensions on both platforms\' spellings', () => {
    for (const p of [
      '/Users/me/evil.app',
      '/Users/me/evil.command',
      '/Users/me/evil.exe',
      'C:\\Users\\me\\evil.bat',
      'C:\\Users\\me\\evil.lnk',
      '/Users/me/evil.APP',
      '/Users/me/x.workflow',
    ]) {
      expect(safeOpenPath(p), p).toBeNull()
    }
  })

  it('allows documents and folders anywhere (users open picked attachments)', () => {
    for (const p of ['/Users/me/报告.txt', 'C:\\Users\\me\\notes.md', '/Users/me/Projects', '/a/folder.d']) {
      expect(safeOpenPath(p), p).toBe(p)
    }
  })

  it('denies empty and NUL spellings; a dot in a directory name is not an extension', () => {
    expect(safeOpenPath('')).toBeNull()
    expect(safeOpenPath('  ')).toBeNull()
    expect(safeOpenPath('/a/b\0.app')).toBeNull()
    expect(safeOpenPath('/a/b\0.png')).toBeNull()  // NUL truncates the visible name
    expect(safeOpenPath('/Users/me/my.dir/')).toBe('/Users/me/my.dir/')
  })
})
