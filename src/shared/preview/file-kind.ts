// ── Preview file-kind detection (PLAN-preview-pane §设计1) ──
// Pure extension→kind mapping shared by the preview pane renderers and the
// auto-open heuristics. Single source of truth for "which files can the pane
// render": IMAGE_EXTS here is the canonical set (LocalImage.tsx imports it).

export type FileKind = 'markdown' | 'text' | 'image' | 'html' | 'csv' | 'office' | 'binary'

export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

const MARKDOWN_EXTS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx'])
const HTML_EXTS: ReadonlySet<string> = new Set(['html', 'htm'])
const CSV_EXTS: ReadonlySet<string> = new Set(['csv', 'tsv'])
const OFFICE_EXTS: ReadonlySet<string> = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
])

// Code sources and config/plain-text formats the highlighter family can show.
const TEXT_EXTS: ReadonlySet<string> = new Set([
  'txt', 'log', 'text', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs',
  'php', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'css', 'scss', 'sass', 'less', 'styl',
  'vue', 'svelte', 'astro',
  'xml', 'plist', 'graphql', 'gql', 'proto', 'lua', 'r', 'dart', 'scala', 'clj', 'ex', 'exs',
  'erb', 'hbs', 'ejs', 'pug', 'jade',
])

// Extension-less names the pane still previews as text.
const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  'makefile', 'dockerfile', 'procfile', 'rakefile', 'gemfile', 'license', 'licence', 'notice',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  '.env', '.babelrc', '.dockerignore',
])

/** Last path segment (both separators), query/hash stripped. */
export function baseName(path: string): string {
  const clean = path.replace(/[?#].*$/, '')
  const sep = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return sep >= 0 ? clean.slice(sep + 1) : clean
}

/** Lowercased final extension ('' when absent), query/hash stripped. */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  // dot > 0 keeps dotfiles like ".env" extension-less instead of ext "env"
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Kind for a path by extension / well-known filename. Unknown → 'binary'. */
export function detectFileKind(path: string): FileKind {
  const name = baseName(path).toLowerCase()
  if (TEXT_FILENAMES.has(name)) return 'text'
  const ext = extensionOf(name)
  if (!ext) return 'binary'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (CSV_EXTS.has(ext)) return 'csv'
  if (OFFICE_EXTS.has(ext)) return 'office'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

/** Kinds the pane can render inline this milestone (D6). */
export function isPreviewable(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'text' || kind === 'image' || kind === 'html' || kind === 'csv'
}

/** Should a successful `write` auto-open the pane (D3: previewable only). */
export function shouldAutoOpen(path: string): boolean {
  return isPreviewable(detectFileKind(path))
}
