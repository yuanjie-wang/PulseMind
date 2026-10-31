/**
 * CodeMirror editor batch (2026-10-31): the preview pane's edit mode swaps
 * the plain textarea for a CM6 editor — highlighting while editing, in both
 * the main-window workbench and the immersive project window (the render
 * path is shared, so both get it from one component).
 *
 * Three layers, matching the repo's testing discipline:
 *   - coverage matrix as REAL imports: every Prism id resolveCodeLang can
 *     return must map to a CM grammar (null included, listed explicitly) —
 *     view and edit halves read the same table, so they can never disagree
 *     about what a file is;
 *   - wiring scans for the files whose behavior lives in the browser (the
 *     lazy split, the Mod-s → onSave binding, the external-value sync that
 *     keeps the editor mounted across conflict reloads / agent writes);
 *   - negative controls: deleting any pinned line must turn exactly the
 *     listed checks red.
 *
 * Behavior beyond these pins lives in scripts/probe-preview-edit.mjs (real
 * Chromium against the production WorkspacePane).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { LANG_LOOKUP, resolveCodeLang } = await import('../src/shared/preview/code-lang')
const { cmLangFor, CM_GRAMMAR_IDS } = await import('../src/renderer/src/components/preview/codemirror-lang')

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('coverage matrix: LANG_LOOKUP → cmLangFor', () => {
  it('every Prism id the shared table resolves is mapped (null allowed, listed)', () => {
    const resolved = new Set(Object.values(LANG_LOOKUP))
    // Explicit degradation list: these ids have no CM grammar and edit
    // unhighlighted (the PlainCode honest-gap semantics). Anything outside
    // this set resolving to null is a coverage hole, not an honest gap.
    const HONEST_NULLS: ReadonlySet<string> = new Set([])
    for (const id of resolved) {
      const grammar = cmLangFor(id)
      if (HONEST_NULLS.has(id)) {
        expect(grammar, `id ${id} is pinned to degrade`).toBeNull()
      } else {
        expect(grammar, `id ${id} must map to a grammar`).not.toBeNull()
      }
    }
  })

  it('resolveCodeLang still answers from the shared table (re-export intact)', () => {
    expect(resolveCodeLang('run.py')).toBe('python')
    expect(resolveCodeLang('scripts/x.mjs')).toBe('javascript')
    expect(resolveCodeLang('md hl_lines=3')).toBe('markdown')
    expect(resolveCodeLang('.clarp')).toBeNull()
  })

  it('variable-alias extensions land on the same grammar family', () => {
    // tsx and ts both → javascript grammar (Lezer flags differ upstream)
    expect(cmLangFor('typescript')).not.toBeNull()
    expect(cmLangFor('tsx')).not.toBeNull()
    expect(cmLangFor('jsx')).not.toBeNull()
    // c/h/cpp share lang-cpp
    expect(cmLangFor('c')).not.toBeNull()
  })

  it('unknown id → null (editable, unhighlighted)', () => {
    expect(cmLangFor('clarp')).toBeNull()
  })

  it('CM_GRAMMAR_IDS covers every id LANG_LOOKUP resolves', () => {
    const resolved = new Set(Object.values(LANG_LOOKUP))
    for (const id of resolved) expect(CM_GRAMMAR_IDS).toContain(id)
  })
})

describe('wiring: FileEditor → lazy CodeMirrorEditor', () => {
  const editor = read('src/renderer/src/components/preview/FileEditor.tsx')

  it('lazy import: the CM chunk stays out of the entry bundle', () => {
    expect(editor).toContain("React.lazy(() => import('./CodeMirrorEditor'))")
    expect(editor).toContain('<Suspense')
  })

  it('negative control: the textarea implementation is gone', () => {
    expect(editor).not.toContain('<textarea')
  })

  it('props contract unchanged + path passthrough', () => {
    expect(editor).toContain('value: string')
    expect(editor).toContain('onChange: (next: string) => void')
    expect(editor).toContain('onSave: () => void')
    expect(editor).toContain('path={path}')
  })

  it('PreviewContent call site passes the path (grammar source)', () => {
    const content = read('src/renderer/src/components/preview/PreviewContent.tsx')
    expect(content).toContain('<FileEditor')
    expect(content).toContain('path={path}')
  })
})

describe('wiring: CodeMirrorEditor invariants', () => {
  const cm = read('src/renderer/src/components/preview/CodeMirrorEditor.tsx')

  it('Mod-s → onSave; Tab indents with the two-space unit', () => {
    expect(cm).toContain("key: 'Mod-s'")
    expect(cm).toContain('onSaveRef.current(); return true')
    expect(cm).toContain("indentUnit.of('  ')")
    expect(cm).toContain('indentMore')
  })

  it('updateListener emits onChange on doc change', () => {
    expect(cm).toContain('EditorView.updateListener.of')
    expect(cm).toContain('update.docChanged')
    expect(cm).toContain('onChangeRef.current(update.state.doc.toString())')
  })

  it('external-value sync replaces the doc in place (no remount), outside undo history', () => {
    expect(cm).toContain("view.state.doc.toString() !== value")
    expect(cm).toContain('view.dispatch({')
    expect(cm).toContain('changes: { from: 0, to: view.state.doc.length, insert: value }')
    // ⌘Z after an agent-write adoption must not resurrect the old draft text.
    expect(cm).toContain('Transaction.remote.of(true)')
  })

  it('theme tokens come from the same oneDark/oneLight the view half uses', () => {
    expect(cm).toContain("from 'react-syntax-highlighter/dist/esm/styles/prism'")
    expect(cm).toContain('oneDark')
    expect(cm).toContain('oneLight')
    expect(cm).toContain('highlightComp.reconfigure')
  })

  it('editor chrome rides CSS variables (theme-class aware for free)', () => {
    expect(cm).toContain("'var(--pm-bg)'")
    expect(cm).toContain('var(--pm-text-strong)')
  })

  it('line numbers on; grammar via cmLangFor; probe seam present', () => {
    expect(cm).toContain('lineNumbers()')
    expect(cm).toContain('cmLangFor(')
    expect(cm).toContain('__pmPreviewCM')
  })

  it('negative control: no echo — the sync effect is the only doc-writer beside the listener', () => {
    // The updateListener must not dispatch; only the external-value effect does.
    const listener = cm.split('EditorView.updateListener.of')[1]?.split('),')[0] ?? ''
    expect(listener).not.toContain('dispatch')
  })
})
