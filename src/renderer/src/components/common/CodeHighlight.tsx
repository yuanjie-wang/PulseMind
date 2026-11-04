import React from 'react'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { highlightToHtml, codeShellStyles, type ThemeObj } from './fast-code'
import { useThemeMode } from '../../theme/mode'
// The language table lives in shared/preview/code-lang.ts (the CM editor keys
// its grammar mapping off the same ids) — re-exported here so every existing
// consumer keeps importing from this module.
export { LANG_LOOKUP, resolveCodeLang } from '../../../../shared/preview/code-lang'

// Tree-shaken highlighter, fast-path edition (2026-10-31): the language set
// is LANG_LOOKUP (shared/preview/code-lang.ts); `fast-code.ts` registers the
// same set into its own refractor core and renders tokens to an HTML string.
// react-syntax-
// highlighter's per-token React pipeline measured ~4ms/KB of blocking per
// mount (probe-tree-click-jank.mjs — a 280-line file was one ~300-500ms frame
// per preview switch, and rapid tree clicks queue one per click); the string
// builder mounts the same DOM for a fraction of that and caches repeat mounts.
// The library stays in the bundle for @ant-design/x's own highlighter.
//
// Since PLAN-codemirror-view (2026-11-01) this serves the CHAT code fences
// and the skill browser preview only — the preview pane's text view moved to
// the CodeMirror instance (line numbers and reveal went with it; the
// lineNumbers/revealLine props and the `[data-reveal-line]` contract retired
// with the preview path).

const FONT_STACK = 'Menlo, Consolas, monospace'

interface CodeHighlightProps {
  code: string
  /** A language id returned by resolveCodeLang. */
  lang: string
  /** Code font size; the chat markdown theme uses 14, the skill preview 12. */
  fontSize?: number
}

/** Prism-highlighted code, rendered through the fast string builder
 *  (fast-code.ts): one `dangerouslySetInnerHTML` on the code element — the
 *  browser's HTML parser builds the token spans, React never sees a per-token
 *  element tree. The shell keeps the captured production shape: the pre carries
 *  the theme's base ink/metrics under the app's card look; every token span
 *  carries the same inline style the library's `theme[className]` lookup
 *  produced, so the visible result is unchanged.
 *
 *  The outer tag is a DIV, not a pre: x-markdown wraps code fences in its own
 *  `<pre>` (no nesting); the code element's `white-space: pre-wrap` gives it
 *  the pre behavior. Standalone callers (skill browser) get the mode-correct
 *  card look from the shell's inline styles.
 *
 *  The two halves of a code block flip by different means, and that split is
 *  the reason this file subscribes to the theme mode at all: the card
 *  (background, padding, radius) is CSS and rides `--pm-code-bg` like every
 *  other migrated surface, while the TOKENS are a JS object — Prism's theme
 *  is `{ '.token.keyword': { color } }`, unreachable from a custom property —
 *  so `oneDark`/`oneLight` must be chosen in JS. `useThemeMode` is the module
 *  store for exactly this shape of consumer (see `theme/mode.ts`). */
export const CodeHighlight = React.memo(function CodeHighlight({ code, lang, fontSize = 12 }: CodeHighlightProps): React.ReactElement {
  const mode = useThemeMode()
  // The library's theme type gives each class a CSSProperties value without an
  // index signature, so it never structurally matches a Record — the shape is
  // exactly what fast-code's StyleObj reads, cast at the single selection point.
  const theme = (mode === 'dark' ? oneDark : oneLight) as unknown as ThemeObj
  const html = React.useMemo(
    () => highlightToHtml(code, lang, theme),
    [code, lang, theme],
  )
  const shell = React.useMemo(() => codeShellStyles(theme, fontSize, FONT_STACK), [theme, fontSize])
  return (
    <div style={shell.pre}>
      <code style={shell.code} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

/** Plain-text fallback for languages outside LANG_LOOKUP. Its card and its ink
 *  are both CSS, so it needs no mode subscription at all.
 *
 *  Large code is CHUNKED into blocks each carrying `content-visibility: auto`:
 *  element-level content-visibility cannot help the single-<pre> shape (the
 *  pre is on-screen, so all N thousand wrapped lines lay out anyway — 1.6MB
 *  measured 315ms of layout, still 207ms with the property on), but per-block
 *  skipping lays out only the blocks near the viewport. Mount drops to
 *  block-element cost; scrolling pays each block once, ~ms apiece.
 *
 *  Two size facts measured 2026-10-31 (wrap-bench, direct-DOM A/B on the
 *  1.6MB/20K-line fixture):
 *   * the placeholder height must MATCH the block: a fixed 'auto 100px'
 *     against a real ~5760px block made every newly-rendered block shift the
 *     whole page (mount 1.8s, scroll p95 ~170ms). Per-block
 *     `lines × fontSize × 1.6` estimates fixed both.
 *   * 60-line blocks scroll with ZERO stalls; 300-line blocks reliably
 *     produced one ~133ms stall per run (the block is the paint granule —
 *     scrolling into one rasterizes all of it). Block count is free (333
 *     <div>s for 20K lines). */
const PLAIN_CHUNK_CHARS = 100_000
const PLAIN_BLOCK_LINES = 60

export const PlainCode = React.memo(function PlainCode({ code, fontSize = 12 }: { code: string; fontSize?: number }): React.ReactElement {
  const preStyle: React.CSSProperties = {
    margin: 0,
    padding: 12,
    background: 'var(--pm-code-bg)',
    fontSize,
    lineHeight: 1.6,
    fontFamily: FONT_STACK,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--pm-text-strong)'
  }
  // The placeholder must match what the block will really be, or every
  // newly-rendered block shifts the whole page (see the size-facts note
  // above): lineHeight 1.6 × fontSize is the rendered row height.
  const intrinsicSizeOf = (lineCount: number): string =>
    `auto ${Math.round(lineCount * fontSize * 1.6)}px`
  if (code.length <= PLAIN_CHUNK_CHARS) {
    const lineCount = code.split('\n').length
    return (
      <pre style={{ ...preStyle, contentVisibility: 'auto', containIntrinsicSize: intrinsicSizeOf(lineCount) }}>
        {code}
      </pre>
    )
  }
  const lines = code.split('\n')
  const blocks: string[] = []
  for (let at = 0; at < lines.length; at += PLAIN_BLOCK_LINES) {
    blocks.push(lines.slice(at, at + PLAIN_BLOCK_LINES).join('\n'))
  }
  return (
    <div>
      {blocks.map((block, i) => (
        <pre
          key={i}
          style={{
            ...preStyle,
            // First block paints now; the rest are placeholders until scrolled
            // near. padding-top drops on later blocks (the previous block's
            // bottom padding already separates them).
            paddingTop: i === 0 ? 12 : 0,
            contentVisibility: 'auto',
            containIntrinsicSize: intrinsicSizeOf(Math.min(PLAIN_BLOCK_LINES, lines.length - i * PLAIN_BLOCK_LINES))
          }}
        >
          {block}
        </pre>
      ))}
    </div>
  )
})
