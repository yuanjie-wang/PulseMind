// ── CodeMirror 6 editor+viewer for the preview pane (2026-10-31 CM batch;
//    2026-11-01: the VIEW half unified onto this component —
//    PLAN-codemirror-view) ──
//
// One lazy component serves BOTH preview modes for text files. The edit half
// (highlighted editing, ⌘S, tab indent) landed 2026-10-31; the view half —
// retired from the string-built CodeHighlight/PlainCode render — rides the
// same instance through a mode Compartment: switching 查看↔编辑 reconfigures
// in place, never remounts, so scroll position, undo history and drafts
// survive the flip.
//
// Controlled-contract notes (the invariants the probe pins):
// 1. Echo guard: the updateListener only emits `onChange` — and only when a
//    listener exists (the view half passes none). The external-value effect
//    compares the incoming prop against `view.state.doc`; an emitted value
//    round-trips equal, so no dispatch, no echo loop.
// 2. No remount on external value adoption: conflict reload / agent write
//    (bumpReload) flow through that same effect as a full-doc dispatch — the
//    DOM node survives. `Transaction.remote` keeps adoption OUT of the undo
//    history (⌘Z after an agent write must not resurrect the pre-adoption
//    draft text and silently diverge from disk).
// 3. The view half MUST NOT pass onChange: the view→edit flip adopts the
//    draft value through the external-value effect, and a live listener
//    would feed that disk text straight back into the draft setter — wiping
//    the dirty draft the flip was meant to keep (PreviewContent guards this
//    by passing `onChange` only in edit mode).
//
// Tokens come from the SAME oneDark/oneLight Prism theme objects the old
// view half used (fast-code's `theme[className]` keys — bare token names),
// mapped to Lezer tags via HighlightStyle; the highlight Compartment swaps
// it on theme flips. The chrome rides CSS variables and follows the theme
// class for free.
//
// Reveal (PLAN-ide-linkage 1b; read tools / edit errors / search hits): a
// StateEffect carrying a 1-based line drives a line-decoration StateField —
// the `.pm-cm-reveal` class paints the warn background for REVEAL_FLASH_MS
// (PreviewContent owns the timer and passes null to drop it), and
// `scrollIntoView(y: 'center')` lands the target. Works in both modes.
//
// Completion + search (user 2026-11-01, reversing the 10-31 weak-IDE ruling
// for exactly these two): `autocompletion()` in the edit group activates the
// sources the language packages already ship; `search()` + `searchKeymap`
// are global so ⌘F works while reading (the view content carries tabindex
// for that). Still no `codemirror` meta package, no lint, no LSP.
//
// Search panel i18n + chrome (2026-11-02): every visible panel string rides
// `state.phrase()` — `searchPhrases` maps the package's English phrase keys
// onto the app dictionary through a `localeComp` Compartment (locale flip
// reconfigures in place; an already-open panel keeps its DOM until it is
// closed again). The label checkboxes center via inline-flex — CM's base
// theme leaves them on the text baseline, which reads as hanging low.

import React, { useEffect, useRef } from 'react'
import {
  Compartment,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  Text,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { autocompletion } from '@codemirror/autocomplete'
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { unifiedMergeView } from '@codemirror/merge'
import { tags } from '@lezer/highlight'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { registerPreviewCmView, takePreviewPanelOpen, unregisterPreviewCmView } from './preview-cm-seam'
import { useTranslation } from '../../i18n/useTranslation'
import { useThemeMode } from '../../theme/mode'
import { extensionOf } from '../../../../shared/preview/file-kind'
import { resolveCodeLang } from '../../../../shared/preview/code-lang'
import { cmLangFor } from './codemirror-lang'
import type { StyleObj, ThemeObj } from '../common/fast-code'

export interface CodeMirrorEditorProps {
  value: string
  /** Edit half only. Deliberately ignored in view mode (header note 3). */
  onChange?: (next: string) => void
  /** Edit half only: ⌘S / Ctrl+S asks the parent to save. */
  onSave?: () => void
  /** Resolved against the shared language table to pick the grammar; an
   *  unknown extension still renders/edits, just unhighlighted. */
  path?: string
  /** View half (default false): no cursor, no editing, the retired
   *  CodeHighlight card look, soft wrapping. Flips reconfigure the mode
   *  Compartment in place — never a remount. */
  readOnly?: boolean
  /** 1-based line to scroll into view + flash (`pm-cm-reveal` warn line);
   *  null drops the decoration. */
  revealLine?: number | null
  /** Agent-change review diff (2026-11-01 pivot): the PRE-CHANGE text the
   *  view half highlights the current (disk) doc against — what the agent
   *  changed, read-only, no accept/reject controls. View half only (the edit
   *  half is the user's own typing — no diff there, user ruling); null drops
   *  the merge extension entirely. */
  viewDiffBase?: string | null
}

const MONO_STACK = "'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace"
/** The retired view half's font stack (CodeHighlight.tsx) — the card look
 *  carries over unchanged. */
const VIEW_FONT_STACK = "'Menlo', 'Consolas', monospace"

/** Prism token entry → HighlightStyle entry props (color + fontStyle only;
 *  the themes carry nothing else the editor should inherit). */
function tokenOf(theme: ThemeObj, name: string): { color?: string; fontStyle?: string } {
  const entry = theme[name] as StyleObj | undefined
  if (!entry) return {}
  const out: { color?: string; fontStyle?: string } = {}
  if (typeof entry.color === 'string') out.color = entry.color
  if (typeof entry.fontStyle === 'string') out.fontStyle = entry.fontStyle
  return out
}

/** Map the Prism token names (the bare keys the rsh theme objects use) onto
 *  Lezer highlight tags. Curated to the tags CM's grammars actually emit —
 *  entries whose theme key is missing are dropped. */
function buildHighlightStyle(theme: ThemeObj): HighlightStyle {
  const define = (tag: Parameters<typeof HighlightStyle.define>[0][number]['tag'], name: string) => ({
    tag,
    ...tokenOf(theme, name),
  })
  const entries = [
    define(tags.keyword, 'keyword'),
    define([tags.string, tags.special(tags.string)], 'string'),
    define(tags.comment, 'comment'),
    define([tags.number, tags.bool, tags.atom], 'number'),
    define(tags.function(tags.variableName), 'function'),
    define([tags.className, tags.typeName], 'class-name'),
    define(tags.tagName, 'tag'),
    define(tags.attributeName, 'attr-name'),
    define(tags.propertyName, 'property'),
    define(tags.operator, 'operator'),
    define(tags.punctuation, 'punctuation'),
    define(tags.variableName, 'variable'),
    define(tags.standard(tags.variableName), 'builtin'),
    define(tags.regexp, 'regex'),
    define(tags.character, 'char'),
    define([tags.url, tags.link], 'url'),
    define(tags.strong, 'bold'),
    define(tags.emphasis, 'italic'),
    define(tags.meta, 'important'),
  ].filter((e) => e.color !== undefined)
  return HighlightStyle.define(entries)
}

const HIGHLIGHT_DARK = buildHighlightStyle(oneDark as unknown as ThemeObj)
const HIGHLIGHT_LIGHT = buildHighlightStyle(oneLight as unknown as ThemeObj)

/** Swap point for the theme flip (CSS vars handle the chrome; only the token
 *  colors need a JS-side reconfigure). */
const highlightComp = new Compartment()

/** Swap point for the mode flip (view ↔ edit): the whole editable/chrome/
 *  active-line/keymap group reconfigures in place. */
const modeComp = new Compartment()

/** Edit-half chrome: the pane's editor look (probe-theme-dark §15 pins this
 *  ink pair — do not retune without re-baselining that probe). */
const chromeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--pm-bg)',
    color: 'var(--pm-text-strong)',
  },
  '.cm-scroller': {
    fontFamily: MONO_STACK,
    lineHeight: '1.6',
  },
  '.cm-content': {
    padding: '12px 0 12px 8px',
    caretColor: 'var(--pm-ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--pm-bg)',
    color: 'var(--pm-text-faint)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--pm-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--pm-hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--pm-ink)' },
})

/** View-half chrome: the retired CodeHighlight card look — the `--pm-code-bg`
 *  card, the view font stack, the 12px padding — with no active-line pair and
 *  no cursor. Soft wrapping rides this group too (the view pre was pre-wrap);
 *  the editor half keeps no-wrap with horizontal scroll. */
const viewTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--pm-code-bg)',
    color: 'var(--pm-text-strong)',
    borderRadius: '8px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: VIEW_FONT_STACK,
    lineHeight: '1.6',
  },
  '.cm-content': {
    padding: '12px 12px 12px 8px',
    caretColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--pm-code-bg)',
    color: 'var(--pm-text-faint)',
    border: 'none',
  },
})

/** Search panel / completion tooltip / match highlights on the app's
 *  variables (CM's own base theme hard-codes light-ish colors that would sit
 *  wrong on the dark palette). Mode-independent — rides the global group.
 *
 *  2026-11-02 rework (user round 2): the package's DOM is one flat inline
 *  flow with a `<br>` before the replace row — flexed into centered rows
 *  (baseline flow left the checkboxes/labels misaligned against the taller
 *  inputs/buttons), `<br>` hidden, gap does the spacing. Buttons get the
 *  app's quiet secondary look (card surface, hairline border, 6px radius,
 *  ink hover). The close × gets a real ~22px hit target with a hover state.
 *  Match highlights: the bare warn tint was too faint — every hit gets a
 *  warn OUTLINE (outline paints outside the flow; a border would reflow the
 *  line) and the current match deepens the fill. */
const uiTheme = EditorView.theme({
  '.cm-panels': {
    backgroundColor: 'var(--pm-bg)',
    color: 'var(--pm-text-strong)',
    fontSize: '12px',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--pm-border-hairline)' },
  '.cm-panel.cm-search': {
    // Right padding reserves the close button's corner.
    padding: '6px 36px 6px 8px',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
  },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '0' },
  // Textfields: card surface, 24px box matching the buttons. :not(checkbox)
  // — the type-rule below must not pad the three checkboxes.
  '.cm-panel.cm-search input:not([type=checkbox])': {
    fontSize: '12px',
    lineHeight: '20px',
    padding: '1px 8px',
    color: 'var(--pm-text-strong)',
    backgroundColor: 'var(--pm-card)',
    border: '1px solid var(--pm-border-hairline)',
    borderRadius: '6px',
  },
  '.cm-panel.cm-search input[name=search], .cm-panel.cm-search input[name=replace]': { width: '160px' },
  '.cm-panel.cm-search input:not([type=checkbox]):focus': { outline: 'none', borderColor: 'var(--pm-ink)' },
  '.cm-panel.cm-search button': {
    fontSize: '12px',
    lineHeight: '20px',
    padding: '1px 10px',
    color: 'var(--pm-text-strong)',
    backgroundColor: 'var(--pm-card)',
    // CM's baseTheme paints .cm-button a LIGHT gradient via background-image
    // (`&light .cm-button`) — the editor root is always cm-light here (no
    // {dark:true} theme exists), so the gradient rides over the card color
    // and glares in dark mode. background-COLOR does not override it; only
    // an explicit none does. The :active re-paint gets the same treatment.
    backgroundImage: 'none',
    border: '1px solid var(--pm-border-hairline)',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button:active': { backgroundImage: 'none' },
  '.cm-panel.cm-search button:hover': { borderColor: 'var(--pm-ink)' },
  // The close ×: base theme leaves it a 0-padding bare glyph in the corner —
  // a real hit target plus hover, matching the app's icon-button feel.
  '.cm-panel.cm-search button[name=close]': {
    position: 'absolute',
    top: '4px',
    right: '6px',
    width: '22px',
    height: '22px',
    padding: '0',
    fontSize: '15px',
    lineHeight: '20px',
    textAlign: 'center',
    borderRadius: '6px',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--pm-text-faint)',
  },
  '.cm-panel.cm-search button[name=close]:hover': {
    backgroundColor: 'var(--pm-hover)',
    color: 'var(--pm-text-strong)',
  },
  // Checkbox labels: inline-flex + center — the base theme leaves the box on
  // the text baseline (its only concession is `marginRight: .2em`), which
  // reads as hanging low next to the text. accent-color rides the app ink
  // instead of the UA's blue.
  '.cm-panel.cm-search label': { fontSize: '12px', display: 'inline-flex', alignItems: 'center' },
  '.cm-panel.cm-search input[type=checkbox]': { margin: '0 4px 0 0', accentColor: 'var(--pm-ink)' },
  // Matches (user round 2: the all-matches tint alone was too faint): warn
  // outline on every hit, deeper fill on the current one. Outline, not
  // border — a border adds to the inline box and shifts the line's glyphs.
  '.cm-searchMatch': {
    backgroundColor: 'var(--pm-warn-bg)',
    outline: '1px solid var(--pm-warn)',
    outlineOffset: '-1px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--pm-warn-border)',
    outline: '1px solid var(--pm-warn)',
    outlineOffset: '-1px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--pm-bg)',
    color: 'var(--pm-text-strong)',
    border: '1px solid var(--pm-border-hairline)',
    borderRadius: '6px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: MONO_STACK, fontSize: '12px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--pm-hover)',
    color: 'var(--pm-text-strong)',
  },
})

/** Swap point for the agent-change review diff — empty in edit mode and
 *  whenever there is no pre-change base to show. */
const mergeComp = new Compartment()

/** Swap point for the search-panel phrase table (locale flip). */
const localeComp = new Compartment()

/** The @codemirror/search panel phrases EVERY visible string through
 *  `state.phrase()` — this map is the i18n seam. Keys are the package's
 *  English phrase keys, verbatim (lookup is hasOwnProperty on the exact
 *  string, so a renamed upstream key falls back to its new English until
 *  this map follows; the wire-scan test pins the key set). The `$` in the
 *  two announcement templates is CM's insertion slot — `phrase()`
 *  substitutes the line number / match count for it. */
function searchPhrases(t: (path: string) => string): Record<string, string> {
  return {
    Find: t('previewPane.cmSearch.find'),
    Replace: t('previewPane.cmSearch.replace'),
    next: t('previewPane.cmSearch.next'),
    previous: t('previewPane.cmSearch.previous'),
    all: t('previewPane.cmSearch.all'),
    'match case': t('previewPane.cmSearch.matchCase'),
    regexp: t('previewPane.cmSearch.regexp'),
    'by word': t('previewPane.cmSearch.byWord'),
    replace: t('previewPane.cmSearch.replaceOne'),
    'replace all': t('previewPane.cmSearch.replaceAll'),
    close: t('previewPane.cmSearch.close'),
    'Go to line': t('previewPane.cmSearch.gotoLine'),
    go: t('previewPane.cmSearch.gotoSubmit'),
    'current match': t('previewPane.cmSearch.currentMatch'),
    'on line': t('previewPane.cmSearch.onLine'),
    'replaced match on line $': t('previewPane.cmSearch.replacedOnLine'),
    'replaced $ matches': t('previewPane.cmSearch.replacedCount'),
  }
}

/** The merge chrome on the app palette: @codemirror/merge's base theme
 *  hard-codes light-leaning greens (`#2b2` gutter, `rgba(100,160,128,.08)`
 *  fill). The changed-line and gutter roles map to `--pm-success` so the
 *  diff reads on BOTH palettes (palette.ts owns the values). Declared AFTER
 *  unifiedMergeView in buildMergeExt so same-specificity overrides win on
 *  array order. */
const mergeTheme = EditorView.baseTheme({
  '&.cm-merge-b.cm-editor .cm-changedLine': {
    backgroundColor: 'color-mix(in srgb, var(--pm-success) 10%, transparent)',
  },
  '&.cm-merge-b.cm-editor .cm-changedLineGutter': { background: 'var(--pm-success)' },
})

function buildMergeExt(original: string): Extension[] {
  return [
    // mergeControls: false — this is a READ-ONLY review surface (user ruling
    // 「不用接受和拒绝按钮」): changed lines tinted, deleted chunks shown as
    // widgets, nothing clickable.
    unifiedMergeView({ original, mergeControls: false }),
    mergeTheme,
  ]
}

/** One Compartment, one extension group per mode: editable flag, chrome
 *  theme, active-line pair, edit keymap, completion and lineWrapping flip
 *  together. lineNumbers/bracketMatching/history/defaultKeymap/search stay
 *  global. The view content is NOT editable but IS focusable (tabindex, so
 *  ⌘F reaches the keymap — searching while reading is the main use); the
 *  read-only state refuses every doc change, and without contenteditable no
 *  input/beforeinput ever fires, so typing is inert and the undo history
 *  survives the flip. */
function modeGroup(isView: boolean, onSave: () => void): Extension[] {
  if (isView) {
    return [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({ tabindex: '0' }),
      viewTheme,
      EditorView.lineWrapping,
    ]
  }
  return [
    EditorView.editable.of(true),
    chromeTheme,
    highlightActiveLine(),
    highlightActiveLineGutter(),
    // Completion (user 2026-11-01, reversing the weak-IDE ruling): the
    // language packages already ship their sources (scope/keywords/
    // snippets for js, tags+attrs for html, properties for css…) and
    // @codemirror/autocomplete rode in as their transitive dependency — this
    // one extension is what activates them. Edit half only: the view has no
    // caret to complete at.
    autocompletion(),
    keymap.of([
      { key: 'Mod-s', run: () => { onSave(); return true } },
      { key: 'Tab', run: indentMore },
      { key: 'Shift-Tab', run: indentLess },
    ]),
  ]
}

// ── Reveal machinery (header note) ──

const setRevealEffect = StateEffect.define<number | null>()

const revealMark = Decoration.line({ class: 'pm-cm-reveal' })

/** The flash look (the retired fast-code row style, verbatim). A baseTheme
 *  scopes the rule under the editor root — no global sheet, no per-window
 *  injection (popouts are separate documents). */
const revealTheme = EditorView.baseTheme({
  '.pm-cm-reveal': {
    backgroundColor: 'var(--pm-warn-bg)',
    borderRadius: '4px',
    transition: 'background 0.4s',
  },
})

/** Clamp a 1-based reveal line into the live document (a reveal racing an
 *  edit may point past EOF — land on the last line rather than throw). */
function clampLine(n: number, doc: Text): number {
  return Math.min(Math.max(1, Math.floor(n)), doc.lines)
}

const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes)
    for (const e of tr.effects) {
      // MUST filter by effect identity: tr.effects carries every effect in
      // the transaction (Compartment reconfigures included), and those
      // values are not line numbers.
      if (!e.is(setRevealEffect)) continue
      if (e.value == null) next = Decoration.none
      else next = Decoration.set([revealMark.range(tr.state.doc.line(clampLine(e.value, tr.state.doc)).from)])
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

function applyReveal(view: EditorView, line: number | null): void {
  if (line == null) {
    view.dispatch({ effects: setRevealEffect.of(null) })
    return
  }
  const l = view.state.doc.line(clampLine(line, view.state.doc))
  view.dispatch({
    effects: [
      setRevealEffect.of(l.number),
      EditorView.scrollIntoView(l.from, { y: 'center' }),
    ],
  })
}

export default function CodeMirrorEditor({ value, onChange, onSave, path, readOnly, revealLine, viewDiffBase }: CodeMirrorEditorProps): React.ReactElement {
  const mode = useThemeMode()
  const { locale, t } = useTranslation()
  // Resolved in the body so the host can carry it as a probe/inspection
  // attribute; the grammar itself is fixed at mount (path is constant per
  // editor lifetime — PreviewContent keys the subtree per path).
  const langId = resolveCodeLang(extensionOf(path ?? ''))
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest-callback refs: the keymap/updateListener closures are baked into
  // the one-time state, but the parent re-creates these props every render.
  // The sync effect is declared BEFORE the mount effect, so on first commit
  // the refs are populated before the closures read them.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const modeRef = useRef(mode)
  const initialValueRef = useRef(value)
  const initialReadOnlyRef = useRef(!!readOnly)
  useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onSave
    modeRef.current = mode
  }, [onChange, onSave, mode])

  // Mount once per editor lifetime; the grammar is fixed to the mount path
  // (PreviewContent keys the content subtree per path).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const grammar = langId ? cmLangFor(langId) : null
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        bracketMatching(),
        indentUnit.of('  '),
        history(),
        // Search (user 2026-11-01, with completion): ⌘F panel (top, next to
        // the address bar), ⌘G/⇧⌘G next/prev, ⌘D select-next-occurrence,
        // ⌥⌘G go-to-line. Global — searching while READING is the main use,
        // hence the view half's tabindex (modeGroup). Before defaultKeymap so
        // its Escape (panel scope) wins over simplifySelection. NOT
        // highlightSelectionMatches(): measured +20ms on the 1.6MB mount
        // (probe-tree-click-jank §C 81→100ms) for a nicety nobody asked for.
        search({ top: true }),
        keymap.of(searchKeymap),
        localeComp.of(EditorState.phrases.of(searchPhrases(t))),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        modeComp.of(modeGroup(initialReadOnlyRef.current, () => onSaveRef.current?.())),
        highlightComp.of(syntaxHighlighting(modeRef.current === 'dark' ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)),
        revealField,
        revealTheme,
        uiTheme,
        mergeComp.of([]),
        ...(grammar ? [grammar] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChangeRef.current) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    // Menu seam (preview-cm-seam): the ⋯ menu's 搜索/替换 act on the
    // on-screen editor through the zero-import registry.
    registerPreviewCmView(view, openSearchPanel)
    // A parked intent on a FRESH mount: the menu flipped a rich-render view
    // (markdown etc.) to source — this instance is that flip's product.
    // Already editable, so the panel builds with the replace row.
    if (!initialReadOnlyRef.current && takePreviewPanelOpen()) openSearchPanel(view)
    // Probe seam (scripts/probe-preview-edit.mjs): the doc text is not
    // reconstructible from contenteditable's textContent (per-line divs).
    ;(window as unknown as { __pmPreviewCM?: unknown }).__pmPreviewCM = view
    return () => {
      view.destroy()
      viewRef.current = null
      unregisterPreviewCmView(view)
      delete (window as unknown as { __pmPreviewCM?: unknown }).__pmPreviewCM
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time mount; later value/mode changes are separate effects
  }, [])

  // External value adoption (conflict reload / agent write): replace the doc
  // in place — the DOM node survives, no remount. The `Transaction.remote`
  // annotation keeps the adoption OUT of the undo history: ⌘Z after an agent
  // write must not resurrect the pre-adoption draft text and silently
  // diverge from disk (the user's own undo stack starts at the adopted doc).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.remote.of(true),
      })
    }
  }, [value])

  // Mode flip: reconfigure the whole group in place — no remount, scroll
  // position and undo history survive (the point of the unification). The
  // ⋯ menu's 替换 parks an intent before flipping view→source; consuming it
  // HERE (after the reconfigure commit) means the panel is opened against
  // the already-editable state and carries the replace row. close-then-open:
  // a panel already on screen was built under view mode (search-only) and
  // must be rebuilt.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: modeComp.reconfigure(modeGroup(!!readOnly, () => onSaveRef.current?.())),
    })
    if (!readOnly && takePreviewPanelOpen()) {
      closeSearchPanel(view)
      openSearchPanel(view)
    }
  }, [readOnly])

  // Agent-change review diff (2026-11-01 pivot): the VIEW half highlights
  // what the agent changed — doc (post-change disk text) vs the pre-change
  // base, read-only decorations with no controls. Never in edit mode: that
  // renders the user's own draft, and their typing earns no diff (user
  // ruling). The TWO-STEP reconfigure (drop, then add) forces the merge
  // package's state fields to re-init against the NEW original whenever the
  // base is replaced (the next agent change) — immune to whatever
  // field-preservation semantics a version change brings.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (viewDiffBase == null || !readOnly) {
      view.dispatch({ effects: mergeComp.reconfigure([]) })
      return
    }
    view.dispatch({ effects: mergeComp.reconfigure([]) })
    view.dispatch({ effects: mergeComp.reconfigure(buildMergeExt(viewDiffBase)) })
  }, [viewDiffBase, readOnly])

  // Reveal: scroll the target line to pane center + flash the warn
  // decoration; null drops it (PreviewContent consumes after REVEAL_FLASH_MS).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    applyReveal(view, revealLine ?? null)
  }, [revealLine])

  // Theme flip: reconfigure only the token-color compartment.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: highlightComp.reconfigure(syntaxHighlighting(mode === 'dark' ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)),
    })
  }, [mode])

  // Locale flip: reconfigure the search-panel phrase table in place. The
  // panel re-derives its DOM from state.phrase() each time it OPENS, so an
  // already-open panel keeps its old language until closed and reopened
  // (locale changes mid-panel are a corner of a corner — not worth a forced
  // panel rebuild).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: localeComp.reconfigure(EditorState.phrases.of(searchPhrases(t))) })
  }, [locale, t])

  return (
    <div
      ref={hostRef}
      data-pm-cm-editor
      data-pm-cm-lang={langId ?? ''}
      data-pm-cm-mode={readOnly ? 'view' : 'edit'}
      style={{ height: '100%', overflow: 'hidden' }}
    />
  )
}
