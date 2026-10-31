// ── Shared code-language table (extracted from CodeHighlight, 2026-10-31) ──
//
// The single source of truth for "file extension / fence alias → Prism
// language id". `fast-code.ts` registers the same id set into its refractor
// core; the CodeMirror editor (codemirror-lang.ts) keys its language mapping
// off the same ids, so the view and edit halves of the preview pane can never
// disagree about what language a file is.

/** File extension or code-fence alias → registered Prism language. */
export const LANG_LOOKUP: Record<string, string> = {
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
