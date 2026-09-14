import React from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
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
}

/** Prism-highlighted code. `PreTag="div"` keeps it valid inside x-markdown's
 *  own `<pre>` (no nested pre); there the theme CSS overrides background/radius,
 *  standalone callers get the light-gray card look from the inline styles. */
export function CodeHighlight({ code, lang, fontSize = 12 }: CodeHighlightProps): React.ReactElement {
  return (
    <SyntaxHighlighter
      language={lang}
      style={oneLight}
      PreTag="div"
      wrapLongLines
      customStyle={{ margin: 0, padding: 12, background: 'rgba(0, 0, 0, 0.04)', borderRadius: 8, fontSize }}
      codeTagProps={{ style: { fontFamily: FONT_STACK, fontSize, lineHeight: 1.6 } }}
    >
      {code}
    </SyntaxHighlighter>
  )
}

/** Plain-text fallback for languages outside LANG_LOOKUP. */
export function PlainCode({ code, fontSize = 12 }: { code: string; fontSize?: number }): React.ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: 'rgba(0, 0, 0, 0.04)',
        borderRadius: 8,
        fontSize,
        lineHeight: 1.6,
        fontFamily: FONT_STACK,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: '#333'
      }}
    >
      {code}
    </pre>
  )
}
