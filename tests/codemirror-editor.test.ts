/**
 * CodeMirror editor batch (2026-10-31: edit mode swaps the plain textarea
 * for a CM6 editor; 2026-11-01 PLAN-codemirror-view: the VIEW half rides the
 * same lazy instance through a mode Compartment) — in both the main-window
 * workbench and the immersive project window (the render path is shared, so
 * both get it from one component).
 *
 * Three layers, matching the repo's testing discipline:
 *   - coverage matrix as REAL imports: every Prism id resolveCodeLang can
 *     return must map to a CM grammar (null included, listed explicitly) —
 *     view and edit halves read the same table, so they can never disagree
 *     about what a file is;
 *   - wiring scans for the files whose behavior lives in the browser (the
 *     lazy split, the Mod-s → onSave binding, the external-value sync that
 *     keeps the editor mounted across conflict reloads / agent writes, the
 *     view half's readOnly flip and its no-view-listener guard);
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

  it('props contract: edit half unchanged, view half added (PLAN-codemirror-view)', () => {
    expect(editor).toContain('value: string')
    expect(editor).toContain('onChange?: (next: string) => void')
    expect(editor).toContain('onSave?: () => void')
    expect(editor).toContain('path={path}')
    expect(editor).toContain('readOnly={readOnly}')
    expect(editor).toContain('revealLine={revealLine}')
    expect(editor).toContain('viewDiffBase={viewDiffBase}')
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
    expect(cm).toContain('onSave(); return true')
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

describe('wiring: the view half rides the same instance (PLAN-codemirror-view)', () => {
  const cm = read('src/renderer/src/components/preview/CodeMirrorEditor.tsx')
  const content = read('src/renderer/src/components/preview/PreviewContent.tsx')

  it('mode Compartment: the group reconfigures in place on readOnly flips (never a remount)', () => {
    expect(cm).toContain('const modeComp = new Compartment()')
    expect(cm).toContain('modeComp.of(modeGroup(')
    expect(cm).toContain('modeComp.reconfigure(modeGroup(')
  })

  it('view group: not editable + read-only state + card theme on --pm-code-bg + soft wrap', () => {
    expect(cm).toContain('EditorView.editable.of(false)')
    expect(cm).toContain('EditorState.readOnly.of(true)')
    expect(cm).toContain("'var(--pm-code-bg)'")
    expect(cm).toContain('EditorView.lineWrapping')
  })

  it('lineWrapping lives only in the view branch of modeGroup (the editor half scrolls)', () => {
    expect(cm.split('EditorView.lineWrapping').length - 1).toBe(1)
    const fn = cm.slice(cm.indexOf('function modeGroup'), cm.indexOf('const setRevealEffect'))
    expect(fn).toContain('EditorView.lineWrapping')
  })

  it('reveal: StateEffect + line decoration + scrollIntoView center + clamp against EOF races', () => {
    expect(cm).toContain('StateEffect.define<number | null>()')
    expect(cm).toContain("Decoration.line({ class: 'pm-cm-reveal' })")
    expect(cm).toContain('revealField')
    expect(cm).toContain("EditorView.scrollIntoView(l.from, { y: 'center' })")
    expect(cm).toContain('clampLine(')
  })

  it('reveal flash look: warn background rides a scoped baseTheme (no global sheet)', () => {
    expect(cm).toContain("'var(--pm-warn-bg)'")
    expect(cm).toContain('EditorView.baseTheme')
  })

  it('probe anchors: mode attr flips with the prop, seam registered in both modes', () => {
    expect(cm).toContain('data-pm-cm-mode')
    expect(cm).toContain("readOnly ? 'view' : 'edit'")
    expect(cm).toContain('__pmPreviewCM')
  })

  it('updateListener guards on listener presence (view passes none)', () => {
    expect(cm).toContain('if (update.docChanged && onChangeRef.current) onChangeRef.current(update.state.doc.toString())')
  })

  // 阴性对照（2026-11-01 实测）：删 PreviewContent 的 `readOnly={!editMode}`
  // 恰红 2 条 —— 本文件的 'text view wiring' 与 preview-view-cap 的
  // 'text 视图接线'（两文件共享这条接线的钉）。
  it('text view wiring: readOnly flip + NO view-side onChange (adoption must not feed the draft setter)', () => {
    expect(content).toContain('readOnly={!editMode}')
    expect(content).toContain('onChange={editMode ? updateDraft : undefined}')
    expect(content).toContain('value={editMode ? draft?.content ?? state.text : state.text}')
    expect(content).toContain('revealLine={revealLine}')
  })

  it('text branch precedes the generic edit branch (the unified instance answers text first)', () => {
    const text = content.indexOf("if (kind === 'text') {")
    expect(text).toBeGreaterThan(0)
    const generic = content.indexOf('if (editMode && isEditableKind(kind)) {', text)
    expect(generic).toBeGreaterThan(text)
  })
})

describe('wiring: completion + search (user 2026-11-01, weak-IDE ruling reversed for these two)', () => {
  const cm = read('src/renderer/src/components/preview/CodeMirrorEditor.tsx')
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const modeFn = cm.slice(cm.indexOf('function modeGroup'), cm.indexOf('// ── Reveal machinery'))
  // The view branch runs from `if (isView)` up to the EDIT branch's own
  // `return [` (the second one — the first is the view branch's).
  const viewStart = modeFn.indexOf('if (isView)')
  const viewReturn = modeFn.indexOf('return [', viewStart)
  const viewBranch = modeFn.slice(viewStart, modeFn.indexOf('return [', viewReturn + 8))

  it('both packages are declared as devDependencies (renderer bundle; never asar runtime deps)', () => {
    expect(pkg.devDependencies?.['@codemirror/autocomplete']).toBeTruthy()
    expect(pkg.devDependencies?.['@codemirror/search']).toBeTruthy()
    expect(pkg.dependencies?.['@codemirror/autocomplete']).toBeUndefined()
    expect(pkg.dependencies?.['@codemirror/search']).toBeUndefined()
    // Still no meta package (basicSetup would drag lint and more back in).
    expect(pkg.devDependencies?.['codemirror']).toBeUndefined()
    expect(pkg.dependencies?.['codemirror']).toBeUndefined()
  })

  it('autocompletion() lives in the edit branch only (the view has no caret to complete at)', () => {
    // Counted inside modeGroup (the header comment names it too).
    expect(modeFn.split('autocompletion()').length - 1).toBe(1)
    expect(viewBranch).not.toContain('autocompletion')
  })

  it('search is global: panel on top, searchKeymap ahead of defaultKeymap; no selection-match plugin', () => {
    expect(cm).toContain('search({ top: true })')
    expect(cm).toContain('keymap.of(searchKeymap)')
    // highlightSelectionMatches() measured +20ms on the 1.6MB mount
    // (probe-tree-click-jank §C) — deliberately out (the comment names it;
    // the import and the extension line must not).
    expect(cm).not.toContain('import { highlightSelectionMatches')
    expect(cm).not.toContain('        highlightSelectionMatches(),')
    expect(cm.indexOf('keymap.of(searchKeymap)')).toBeLessThan(cm.indexOf('keymap.of([...defaultKeymap, ...historyKeymap])'))
  })

  it('the view content is focusable (tabindex) so ⌘F reaches the keymap while reading', () => {
    expect(viewBranch).toContain("EditorView.contentAttributes.of({ tabindex: '0' })")
    // …but stays non-editable and read-only (typing is inert — probe §12).
    expect(viewBranch).toContain('EditorView.editable.of(false)')
    expect(viewBranch).toContain('EditorState.readOnly.of(true)')
  })

  it('panel/tooltip/match chrome rides the app variables (CM base theme hard-codes light colors)', () => {
    const ui = cm.slice(cm.indexOf('const uiTheme'), cm.indexOf('function modeGroup'))
    expect(ui).toContain("'.cm-panels'")
    expect(ui).toContain("'.cm-searchMatch'")
    expect(ui).toContain("'.cm-tooltip'")
    expect(ui).toContain('var(--pm-bg)')
    expect(ui).toContain('var(--pm-warn-bg)')
    expect(ui).toContain('var(--pm-hover)')
  })
})

describe('wiring: search panel i18n + checkbox centering (2026-11-02)', () => {
  const cm = read('src/renderer/src/components/preview/CodeMirrorEditor.tsx')
  const zh = read('src/renderer/src/i18n/locales/zh.ts')
  const en = read('src/renderer/src/i18n/locales/en.ts')
  // searchPhrases sits between mergeComp's group and mergeTheme — slice the
  // function body only.
  const fn = cm.slice(cm.indexOf('function searchPhrases'), cm.indexOf('const mergeTheme'))

  it('panel strings ride state.phrase via the locale compartment (mount + flip reconfigure)', () => {
    expect(cm).toContain("localeComp.of(EditorState.phrases.of(searchPhrases(t)))")
    expect(cm).toContain('localeComp.reconfigure(EditorState.phrases.of(searchPhrases(t)))')
    expect(cm).toContain("from '../../i18n/useTranslation'")
  })

  it('every @codemirror/search phrase key is mapped — set derived from the installed dist, not hand-copied', () => {
    // The panel phrases every visible string through state.phrase(); a key
    // missing here shows English again in zh. The key SET is extracted from
    // the installed dist (phrase(view, "…") / state.phrase("…") call sites)
    // so an upstream rename turns this red instead of silently degrading.
    const dist = read('node_modules/@codemirror/search/dist/index.js')
    const keys = new Set<string>()
    for (const m of dist.matchAll(/(?:phrase\(view, |state\.phrase\()"([^"]+)"/g)) keys.add(m[1])
    expect(keys.size).toBeGreaterThanOrEqual(17)
    for (const key of keys) {
      const literal = /^[A-Za-z_$][\w$]*$/.test(key) ? `${key}: t(` : `'${key}': t(`
      expect(fn, `phrase key not mapped: ${key}`).toContain(literal)
    }
  })

  it('both dicts carry the full cmSearch table (17 entries each)', () => {
    for (const [locale, src] of [['zh', zh], ['en', en]] as const) {
      const start = src.indexOf('cmSearch: {')
      const section = src.slice(start, src.indexOf('},', start))
      expect(section, `${locale} cmSearch section`).toBeTruthy()
      const count = section.match(/[A-Za-z]\w*: '/g)?.length ?? 0
      expect(count, `${locale} cmSearch entry count`).toBe(17)
    }
  })

  it('checkbox labels center: inline-flex + align-items on the label, deterministic margin on the box', () => {
    const ui = cm.slice(cm.indexOf('const uiTheme'), cm.indexOf('function searchPhrases'))
    expect(ui).toContain("'.cm-panel.cm-search label'")
    expect(ui).toContain("display: 'inline-flex'")
    expect(ui).toContain("alignItems: 'center'")
    expect(ui).toContain("'.cm-panel.cm-search input[type=checkbox]'")
  })
})

describe('wiring: search panel chrome rework + menu seam (2026-11-02 round 2)', () => {
  const cm = read('src/renderer/src/components/preview/CodeMirrorEditor.tsx')
  const seam = read('src/renderer/src/components/preview/preview-cm-seam.ts')
  const menu = read('src/renderer/src/components/workbench/preview-file-actions.tsx')
  const ui = cm.slice(cm.indexOf('const uiTheme'), cm.indexOf('function searchPhrases'))

  it('panel rows are flex-centered: wrap + align-items, the <br> hidden, margins on the gap', () => {
    expect(ui).toContain("display: 'flex'")
    expect(ui).toContain("flexWrap: 'wrap'")
    expect(ui).toContain("alignItems: 'center'")
    // The package interleaves a literal <br> before the replace row — hidden,
    // flex-wrap owns the flow now.
    expect(ui).toContain("'.cm-panel.cm-search br'")
    expect(ui).toContain("margin: '0'")
  })

  it('panel chrome rides the app card/border/ink roles (buttons + textfields + close)', () => {
    expect(ui).toContain("'var(--pm-card)'")
    expect(ui).toContain("'.cm-panel.cm-search button[name=close]'")
    expect(ui).toContain("width: '22px'")
    // :not(checkbox) — the textfield rule must not pad the three checkboxes.
    expect(ui).toContain("input:not([type=checkbox])")
    // CM's baseTheme paints .cm-button a LIGHT gradient via background-image
    // (`&light .cm-button`; the editor root is always cm-light — no
    // {dark:true} theme exists). background-color does NOT override it: in
    // dark the buttons glared light-gray (user report 2026-11-02). :active
    // re-paints too — both states need the explicit none.
    expect(ui).toContain("backgroundImage: 'none'")
    expect(ui).toContain("button:active': { backgroundImage: 'none' }")
  })

  it('match highlights: warn OUTLINE on every hit (border would reflow the line), deeper fill on current', () => {
    expect(ui.split("outline: '1px solid var(--pm-warn)'").length - 1).toBe(2)
    expect(ui).toContain("outlineOffset: '-1px'")
    expect(ui).toContain("'var(--pm-warn-border)'")
  })

  it('seam is zero-runtime-import (type-only) so the lazy CM chunk stays out of the entry graph', () => {
    expect(seam).toContain("import type { EditorView } from '@codemirror/view'")
    expect(seam).not.toContain("from '@codemirror/search'")
    expect(seam).not.toContain("from './CodeMirrorEditor'")
  })

  it('menu rides the seam, never CodeMirrorEditor directly; ONE merged 查找替换 entry', () => {
    expect(menu).toContain("from '../preview/preview-cm-seam'")
    expect(menu).not.toContain("from '../preview/CodeMirrorEditor'")
    expect(menu).toContain("key: 'searchReplace'")
    // The two-entry layout is gone: view flips to source (park intent), source
    // opens directly; ⌘F stays the read-only pure-search path in view.
    expect(menu).not.toContain("key: 'search'")
    expect(menu).not.toContain("key: 'replace'")
    expect(menu).toContain('parkPreviewPanelOpen()')
  })

  it('editor registers on mount and consumes the parked intent AFTER the readOnly reconfigure', () => {
    expect(cm).toContain('registerPreviewCmView(view, openSearchPanel)')
    expect(cm).toContain('unregisterPreviewCmView(view)')
    const flip = cm.slice(cm.indexOf('// Mode flip:'), cm.indexOf('// Agent-change review diff'))
    expect(flip).toContain('if (!readOnly && takePreviewPanelOpen())')
    expect(flip).toContain('closeSearchPanel(view)')
    expect(flip).toContain('openSearchPanel(view)')
    // Fresh-mount consumption (rich-render view → source flip mounts new).
    const mount = cm.slice(cm.indexOf('const view = new EditorView'), cm.indexOf('return () =>'))
    expect(mount).toContain('takePreviewPanelOpen()')
  })
})
