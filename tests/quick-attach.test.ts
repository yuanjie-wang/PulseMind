// ── Quick-attach: paste / drag-drop into the composer's attachment chips ──
// Three layers, because no single one covers the others:
//
//   - the pure parsing runs for real (file:// URL → path, de-duplicating
//     merge) — vitest can drive it, and it is the only part with real
//     branching worth unit-testing;
//   - the wiring is an invariant of five files no node-env test can mount
//     (Composer must FORWARD onPaste to Sender, InputArea's paste and drag
//     branches must both sit behind showAttachments, dragover must
//     stopPropagation so the window guard's later `dropEffect = 'none'` write
//     cannot overwrite our 'copy', App must install the guard, and both
//     locales must carry the drop hint) — asserted as source;
//   - the runtime consequences (a chip appearing, text NOT landing at the
//     caret, dropEffect surviving, a body drop being swallowed) are DOM facts
//     and live in scripts/probe-input-paste-drop.mjs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileUrlToPath, mergeAttachments, isImageFile } from '../src/renderer/src/utils/quick-attach'

describe('fileUrlToPath', () => {
  it('decodes a plain unix file URL', () => {
    expect(fileUrlToPath('file:///Users/x/a.pdf')).toBe('/Users/x/a.pdf')
  })

  it('decodes percent-encoding (a space in the name)', () => {
    expect(fileUrlToPath('file:///Users/x/My%20Report.pdf')).toBe('/Users/x/My Report.pdf')
  })

  it('accepts a localhost host', () => {
    expect(fileUrlToPath('file://localhost/Users/x/a.pdf')).toBe('/Users/x/a.pdf')
  })

  it('handles the windows drive form in both spellings', () => {
    expect(fileUrlToPath('file:///C:/Users/x/a.pdf')).toBe('C:/Users/x/a.pdf')
    expect(fileUrlToPath('file://C:/Users/x/a.pdf')).toBe('C:/Users/x/a.pdf')
  })

  it('tolerates surrounding whitespace', () => {
    expect(fileUrlToPath('  file:///a.pdf\n'.trim())).toBe('/a.pdf')
  })

  it('rejects anything that is not a single-line local file URL', () => {
    expect(fileUrlToPath('hello world')).toBeNull()
    expect(fileUrlToPath('/Users/x/a.pdf')).toBeNull() // bare path: ambiguous, stays text
    expect(fileUrlToPath('https://example.com/a.pdf')).toBeNull()
    expect(fileUrlToPath('file://remoteserver/share/a.pdf')).toBeNull() // non-local host
    expect(fileUrlToPath('file:///a.pdf\nand a second line')).toBeNull()
    expect(fileUrlToPath('')).toBeNull()
  })

  it('rejects malformed percent-encoding rather than guessing a path', () => {
    expect(fileUrlToPath('file:///a%ZZ.pdf')).toBeNull()
  })
})

describe('mergeAttachments', () => {
  it('appends new paths in order', () => {
    expect(mergeAttachments(['/a'], ['/b', '/c'])).toEqual(['/a', '/b', '/c'])
  })

  it('de-duplicates against the existing list (first wins)', () => {
    expect(mergeAttachments(['/a', '/b'], ['/b', '/a', '/c'])).toEqual(['/a', '/b', '/c'])
  })

  it('de-duplicates within the incoming batch itself', () => {
    expect(mergeAttachments([], ['/a', '/a', '/b'])).toEqual(['/a', '/b'])
  })

  it('drops empties', () => {
    expect(mergeAttachments(['/a'], ['', '/b'])).toEqual(['/a', '/b'])
  })
})

describe('isImageFile', () => {
  it('accepts clipboard image blobs and rejects other clipboard files', () => {
    expect(isImageFile({ type: 'image/png' })).toBe(true)
    expect(isImageFile({ type: 'image/jpeg' })).toBe(true)
    expect(isImageFile({ type: 'application/pdf' })).toBe(false)
    expect(isImageFile({})).toBe(false)
  })
})

// ── wiring scans ──

const REPO = process.cwd()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** The body of a top-level `const <name> = …` inside a component: sliced up
 *  to the next 2-space `const `/`//` marker, which is where this file's
 *  neighbours sit. Enough to assert a gate or a call exists inside IT rather
 *  than somewhere else in the same file. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`)
  expect(start, `const ${name} not found`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n {2}(const |\/\/ |\/\/─|\})/)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('Composer forwards the paste event', () => {
  const src = read('src/renderer/src/components/chat/Composer.tsx')

  it('declares onPaste in its props and hands it to Sender', () => {
    expect(src).toMatch(/onPaste\?:\s*React\.ClipboardEventHandler/)
    expect(src).toMatch(/<Sender[\s\S]*?onPaste=\{onPaste\}/)
  })

  it('does NOT pass onPasteFile — quick-attach owns the file branch alone', () => {
    expect(src).not.toMatch(/onPasteFile=/)
  })

  it('paints the dashed receptacle only through the dropActive class', () => {
    expect(src).toMatch(/className=\{dropActive \? 'pm-drop-active' : undefined\}/)
    expect(src).toMatch(/\.pm-drop-active \.ant-sender/)
    expect(src).toMatch(/border-style:\s*dashed/)
  })
})

describe('InputArea gates both entry points', () => {
  const src = read('src/renderer/src/components/chat/InputArea.tsx')

  it('the paste handler bails before touching the clipboard when attachments are off', () => {
    expect(fnBody(src, 'handlePaste')).toMatch(/if \(!showAttachments\) return/)
    // Interception branches must preventDefault, or the file:// text lands at
    // the caret next to the chip it was meant to become.
    expect(fnBody(src, 'handlePaste')).toMatch(/e\.preventDefault\(\)/)
  })

  it('every drag handler bails when attachments are off or the drag carries no files', () => {
    for (const name of ['handleDragEnter', 'handleDragOver', 'handleDragLeave', 'handleDrop']) {
      expect(fnBody(src, name), name).toMatch(/if \(!showAttachments \|\| !dragHasFiles\(e\)\) return/)
    }
  })

  it('dragover claims the drop: preventDefault + stopPropagation + dropEffect copy', () => {
    const body = fnBody(src, 'handleDragOver')
    expect(body).toMatch(/e\.preventDefault\(\)/)
    // stopPropagation is the load-bearing one: without it the window guard's
    // bubble-phase `dropEffect = 'none'` lands after our 'copy' and the
    // cursor flips to forbidden mid-drag.
    expect(body).toMatch(/e\.stopPropagation\(\)/)
    expect(body).toMatch(/dropEffect = 'copy'/)
    expect(body).toContain('dragDepthRef.current')
  })

  it('drop claims too (so the window guard never sees it) and resets the counter', () => {
    const body = fnBody(src, 'handleDrop')
    expect(body).toMatch(/e\.stopPropagation\(\)/)
    expect(body).toMatch(/dragDepthRef\.current = 0/)
    expect(body).toMatch(/composerRef\.current\?\.focus\(\)/)
  })

  it('mounts all four handlers on the root div and passes paste + dropActive to Composer', () => {
    expect(src).toMatch(/onDragEnter=\{handleDragEnter\}/)
    expect(src).toMatch(/onDragOver=\{handleDragOver\}/)
    expect(src).toMatch(/onDragLeave=\{handleDragLeave\}/)
    expect(src).toMatch(/onDrop=\{handleDrop\}/)
    expect(src).toMatch(/onPaste=\{handlePaste\}/)
    expect(src).toMatch(/dropActive=\{dragActive\}/)
  })

  it('routed paths (picker buttons too) go through the de-duplicating merge', () => {
    expect(fnBody(src, 'addAttachments')).toMatch(/mergeAttachmentsNotified\(prev, files\)/)
    expect(fnBody(src, 'addAttachments')).toMatch(/mergeAttachmentsNotified\(prev, folders\)/)
    expect(src).toMatch(/setSelectedFiles\(\(prev\) => mergeAttachmentsNotified\(prev, result\.filePaths\)\)/)
    expect(src).toMatch(/setSelectedFolders\(\(prev\) => mergeAttachmentsNotified\(prev, result\.filePaths\)\)/)
  })

  it('the drop hint renders in the above-card layer, tail position, both conditions', () => {
    expect(src).toMatch(/\|\| dragActive\) && \(/) // participates in the outer condition
    expect(src).toMatch(/data-drop-hint/)
    expect(src).toMatch(/t\('chatView\.sender\.dropHint'\)/)
    // Tail: it must come AFTER the mention popup's closing or it stacks away
    // from the card.
    expect(src.indexOf('data-drop-hint')).toBeGreaterThan(src.indexOf('data-mention-popup'))
  })
})

describe('window drop guard', () => {
  it('App installs it once', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/useEffect\(\(\) => installFileDropGuard\(window\), \[\]\)/)
  })

  it('the guard forbids (dropEffect none) on dragover and swallows the drop', () => {
    const guard = read('src/renderer/src/utils/file-drop-guard.ts')
    expect(guard).toMatch(/dropEffect = 'none'/)
    expect(guard).toMatch(/target\.addEventListener\('drop'/)
    // The comment that ties the two halves together — if the composer's
    // stopPropagation goes, this contract silently breaks.
    expect(guard).toMatch(/stopPropagation/)
  })

  it('main refuses navigations off the loaded URL / dev origin', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/\.on\('will-navigate'/)
    expect(main).toMatch(/details\.preventDefault\(\)/)
    expect(main).toMatch(/ELECTRON_RENDERER_URL/)
  })
})

describe('both locales carry the hint', () => {
  it('zh and en', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toMatch(/dropHint:\s*'松开添加为引用'/)
    expect(read('src/renderer/src/i18n/locales/en.ts')).toMatch(/dropHint:\s*'Drop files to attach'/)
  })
})

describe('getFileStat carries isDirectory everywhere', () => {
  // The file/folder routing depends on it; a signature that drops the field
  // in ONE of the four places compiles nowhere useful (the bridge) or fails
  // at runtime (the preload), so all four are counted.
  it('four sites', () => {
    const sites = [
      'src/main/services/file-ops.ts',
      'src/main/ipc/app.handler.ts',
      'src/shared/types/electron-bridge.ts',
      'src/preload/index.ts',
    ]
    for (const site of sites) expect(read(site), site).toMatch(/isDirectory/)
  })
})

describe('the getPathForFile bridge (Electron 33 dropped the runtime File.path)', () => {
  // Root cause of 「粘贴/拖拽后没有引用」: electron.d.ts still declares
  // `interface File { path: string }`, so the old `if (file.path)` compiled
  // while every REAL pasted/dropped File read `undefined` — the branch never
  // ran and the file fell through to a silent `continue`. The path now comes
  // from the preload's webUtils bridge; these three scans pin each layer,
  // because node-env vitest cannot mount the component and the Chromium
  // probe stubs the bridge (the REAL runtime contract is
  // scripts/probe-quick-attach-electron.mjs).
  it('preload exposes webUtils.getPathForFile, catch → empty string', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toMatch(/import \{ contextBridge, ipcRenderer, webUtils \} from 'electron'/)
    expect(preload).toMatch(/getPathForFile: \(file: File\): string =>/)
    expect(preload).toMatch(/webUtils\.getPathForFile\(file\)/)
    // The catch is load-bearing: webUtils throws on a non-File, and one
    // throw must not take out the whole paste batch — it reads as '' so the
    // caller falls to the image-blob branch.
    expect(preload).toMatch(/return webUtils\.getPathForFile\(file\)\n {4}\} catch \{\n {6}return ''/)
  })

  it('the bridge interface declares the same signature', () => {
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(/getPathForFile: \(file: File\) => string/)
  })

  it('addQuickFiles asks the bridge FIRST; file.path is only the fallback', () => {
    const body = fnBody(read('src/renderer/src/components/chat/InputArea.tsx'), 'addQuickFiles')
    // The order is the contract: on Electron 33 `.path` is always undefined,
    // so a `.path`-first reading would look green on the probe's legacy
    // cases while breaking in the real app.
    expect(body).toMatch(/getPathForFile\(file\) \|\| \(file as File & \{ path\?: string \}\)\.path/)
    // Pathless blobs (clipboard screenshots) must still reach the image branch.
    expect(body).toMatch(/isImageFile\(file\)/)
  })
})

describe('the Electron probe runs the real preload under app-exact webPreferences', () => {
  // probe-quick-attach-electron.mjs claims its window is created with the
  // app's verbatim webPreferences and that its preload is the real
  // src/preload/index.ts (not a copy). Both halves of that claim are what
  // make "webUtils survives contextBridge under sandbox:true" evidence about
  // the SHIPPED app — a fixture that quietly drifted to sandbox:false would
  // keep proving something weaker with every check still green.
  const probe = read('scripts/probe-quick-attach-electron.mjs')

  it('the fixture webPreferences match the app window key for key', () => {
    for (const key of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'webSecurity: true']) {
      expect(probe, key).toContain(key)
      expect(read('src/main/index.ts'), key).toContain(key)
    }
    // The preload the window loads must be the bundled real one.
    expect(probe).toMatch(/preload: join\(__dirname, 'preload\.cjs'\)/)
    expect(probe).toMatch(/entryPoints: \['src\/preload\/index\.ts'\]/)
    // …and bundled the way scripts/build.js bundles it: only electron
    // external, or webUtils would resolve differently than at launch.
    expect(probe).toMatch(/external: \['electron'\]/)
  })
})
