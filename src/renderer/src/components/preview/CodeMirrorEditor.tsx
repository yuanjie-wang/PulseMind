// ── CodeMirror 6 file editor for the preview pane (2026-10-31 CM batch) ──
//
// The phase-2 editor the old textarea header comment reserved: highlighting
// and editing at once. Incremental Lezer parsing + viewport rendering — DOM
// holds only the visible lines, so mount cost stops scaling with file size
// (the view mode's ~4ms/KB full-render tax is exactly what this avoids).
//
// Controlled-contract notes (the two invariants the probe pins):
// 1. Echo guard: the updateListener only emits `onChange`; the external-value
//    effect below compares the incoming prop against `view.state.doc` — an
//    emitted value round-trips equal, so no dispatch, no echo loop.
// 2. No remount on external value adoption: conflict reload / agent write
//    (bumpReload) flow through that same effect as a full-doc dispatch — the
//    DOM node survives, matching the textarea's NOT-remounted check.
//
// Tokens come from the SAME oneDark/oneLight Prism theme objects the view
// half uses (CodeHighlight.tsx), so edit and view never disagree on a color.
// The chrome (background/gutter/selection) rides CSS variables and follows
// the theme class for free; the HighlightStyle (JS-side colors) is swapped
// through a Compartment on mode flips.

import React, { useEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useThemeMode } from '../../theme/mode'
import { extensionOf } from '../../../../shared/preview/file-kind'
import { resolveCodeLang } from '../../../../shared/preview/code-lang'
import { cmLangFor } from './codemirror-lang'
import type { StyleObj, ThemeObj } from '../common/fast-code'

export interface CodeMirrorEditorProps {
  value: string
  onChange: (next: string) => void
  onSave: () => void
  /** Resolved against the shared language table to pick the grammar; an
   *  unknown extension still edits, just unhighlighted. */
  path?: string
}

const MONO_STACK = "'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace"

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

/** Swap point for the mode flip (CSS vars handle the chrome; only the token
 *  colors need a JS-side reconfigure). */
const highlightComp = new Compartment()

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

export default function CodeMirrorEditor({ value, onChange, onSave, path }: CodeMirrorEditorProps): React.ReactElement {
  const mode = useThemeMode()
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
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        indentUnit.of('  '),
        keymap.of([
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true } },
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        highlightComp.of(syntaxHighlighting(modeRef.current === 'dark' ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)),
        ...(grammar ? [grammar] : []),
        chromeTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    // Probe seam (scripts/probe-preview-edit.mjs): the doc text is not
    // reconstructible from contenteditable's textContent (per-line divs).
    ;(window as unknown as { __pmPreviewCM?: unknown }).__pmPreviewCM = view
    return () => {
      view.destroy()
      viewRef.current = null
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

  // Theme flip: reconfigure only the token-color compartment.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: highlightComp.reconfigure(syntaxHighlighting(mode === 'dark' ? HIGHLIGHT_DARK : HIGHLIGHT_LIGHT)),
    })
  }, [mode])

  return (
    <div
      ref={hostRef}
      data-pm-cm-editor
      data-pm-cm-lang={langId ?? ''}
      style={{ height: '100%', overflow: 'hidden' }}
    />
  )
}
