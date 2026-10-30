import React from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { useThemeMode } from '../../theme/mode'

// Tree-shaken highlighter: PrismLight starts empty, so every language below
// must be registered here.
const LANGUAGES: Record<string, (syntax: unknown) => void> = {
  bash,
  c,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  php,
  python,
  ruby,
  rust,
  sql,
  toml,
  tsx,
  typescript,
  yaml
}
for (const [name, lang] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, lang as never)
}

/** File extension or code-fence alias → registered Prism language. */
const LANG_LOOKUP: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  sql: 'sql',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  'c++': 'cpp',
  toml: 'toml'
}

/** Resolve a file extension, path, or fence info-string alias to a Prism
 *  language id. Accepts full paths (`scripts/run.py` → `py`) and ignores
 *  fence parameters (`js hl_lines=3` → `js`). */
export function resolveCodeLang(extOrAlias: string): string | null {
  let key = extOrAlias.trim().toLowerCase().split(/\s+/)[0]
  if (key.includes('.')) key = key.split('.').pop() ?? ''
  return LANG_LOOKUP[key] ?? null
}

const FONT_STACK = 'Menlo, Consolas, monospace'

interface CodeHighlightProps {
  code: string
  /** A language id returned by resolveCodeLang. */
  lang: string
  /** Code font size; the chat markdown theme uses 14, the skill preview 12. */
  fontSize?: number
  /** Visible line numbers. Preview-only (PLAN-ide-linkage 1a): read prints
   *  absolute line numbers and edit errors cite them, so the preview must
   *  speak the same coordinate system; chat code fences never promised
   *  coordinates, so they stay numberless. Note that wrapLongLines already
   *  renders one span per line — the library forces wrapLines on with it —
   *  so turning numbers on adds the gutter spans, not the per-line wrapping. */
  lineNumbers?: boolean
  /** 1-based line to scroll into view + flash (PLAN-ide-linkage 1b reveal).
   *  The per-line spans carry `data-reveal-line` attrs for the reveal window
   *  only — PreviewContent consumes the target after the flash. */
  revealLine?: number
}

/** The library's line-number box is `minWidth: <digits>.25em` + `paddingRight:
 *  1em` (assembleLineNumberStyles), sized from the LARGEST number it will
 *  print — the same arithmetic here, so the hanging indent below is exactly one
 *  gutter wide. */
function gutterEm(code: string): number {
  const largest = 1 + (code.match(/\n/g)?.length ?? 0)
  return String(largest).length + 1.25
}

/** Prism-highlighted code. `PreTag="div"` keeps it valid inside x-markdown's
 *  own `<pre>` (no nested pre); there the theme CSS overrides background/radius,
 *  standalone callers get the mode-correct card look from the inline styles.
 *
 *  The two halves of a code block flip by different means, and that split is the
 *  reason this file subscribes to the theme mode at all: the card (background,
 *  padding, radius) is CSS and rides `--pm-code-bg` like every other migrated
 *  surface, while the TOKENS are a JS object — Prism's theme is `{ '.token.keyword':
 *  { color } }`, unreachable from a custom property — so `oneDark`/`oneLight` must
 *  be chosen in JS. `useThemeMode` is the module store for exactly this shape of
 *  consumer (see `theme/mode.ts`); the subscription costs one re-render of the
 *  blocks on screen, and the new `style` object is also what re-tokenizes them.
 *
 *  Memoized with the object props built in a useMemo — this component used to
 *  hand SyntaxHighlighter fresh `customStyle`/`codeTagProps` literals every
 *  render, defeating its PureComponent guard, so a drag of the workbench pane
 *  re-tokenized the WHOLE file per 40ms width tick (probe-preview-drag.mjs
 *  measured a 1350ms frame gap on a ~1500-line python file; the memo drops it
 *  to the re-wrap floor). */
export const CodeHighlight = React.memo(function CodeHighlight({ code, lang, fontSize = 12, lineNumbers = false, revealLine }: CodeHighlightProps): React.ReactElement {
  const mode = useThemeMode()
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const customStyle = React.useMemo(
    () => ({ margin: 0, padding: 12, background: 'var(--pm-code-bg)', borderRadius: 8, fontSize }),
    [fontSize],
  )
  const codeTagProps = React.useMemo(
    () => ({ style: { fontFamily: FONT_STACK, fontSize, lineHeight: 1.6 } }),
    [fontSize],
  )
  // The reveal render commits synchronously with this effect — DOM geometry is
  // measurable, scrollIntoView needs no paint wait. wrapLongLines is on, so the
  // target line may occupy several visual rows; the span handles that itself.
  React.useEffect(() => {
    if (revealLine == null || !containerRef.current) return
    const el = containerRef.current.querySelector(`[data-reveal-line="${revealLine}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [revealLine])
  const reveal = revealLine != null
  // Numbered lines are BLOCK rows with a hanging indent one gutter wide. The
  // library's own shape for wrapLongLines + showLineNumbers is `display: flex`
  // per line, which blockifies every token into its own flex item: in a narrow
  // preview column the items shrink and wrap one by one (whitespace between
  // them collapses, the comment overflows to the right, a line grows to 150px of
  // mostly empty rows), and the 800 overflowing flex rows turned every chat
  // scroll into a ~260ms PaintArtifactCompositor::Update (2026-10-30, measured by
  // probe-chat-scroll-pane.mjs: 10 long tasks per burst → 0 with block rows).
  // lineProps spreads after the library's style, so `display` here wins.
  const lineStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!lineNumbers) return undefined
    const em = `${gutterEm(code)}em`
    return { display: 'block', paddingLeft: em, textIndent: `-${em}` }
  }, [lineNumbers, code])
  const lineProps = React.useMemo(() => {
    if (!reveal) return lineStyle ? { style: lineStyle } : undefined
    return (n: number) => ({
      // String value: hast properties drop non-string attribute values.
      'data-reveal-line': String(n),
      style: {
        ...lineStyle,
        ...(n === revealLine ? { background: 'var(--pm-warn-bg)', borderRadius: 4, transition: 'background 0.4s' } : {}),
      },
    })
  }, [reveal, revealLine, lineStyle])
  return (
    <div ref={containerRef}>
      <SyntaxHighlighter
        language={lang}
        style={mode === 'dark' ? oneDark : oneLight}
        PreTag="div"
        wrapLongLines
        showLineNumbers={lineNumbers}
        lineProps={lineProps}
        customStyle={customStyle}
        codeTagProps={codeTagProps}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
})

/** Plain-text fallback for languages outside LANG_LOOKUP. Its card and its ink
 *  are both CSS, so it needs no mode subscription at all. */
export const PlainCode = React.memo(function PlainCode({ code, fontSize = 12 }: { code: string; fontSize?: number }): React.ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: 'var(--pm-code-bg)',
        borderRadius: 8,
        fontSize,
        lineHeight: 1.6,
        fontFamily: FONT_STACK,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--pm-text-strong)'
      }}
    >
      {code}
    </pre>
  )
})
