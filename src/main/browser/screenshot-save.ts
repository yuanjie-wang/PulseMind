// ── Screenshot persistence for the browser tool's `save` option ──
// User ruling 2026-11-11 (「还是有点复杂，能不能全放开，但是不覆盖原文件」):
// `save` accepts ANY destination path. The one hard rule is that an existing
// file is never overwritten — a `-2`, `-3` … suffix is appended (the write
// itself uses `flag: 'wx'`, so the guarantee holds even across a race).
//
// Shapes:
//   true / '' / blank   → auto-named PNG in Downloads
//   '名称.png'          → that filename in Downloads (legacy)
//   '~/Desktop/名称.png' → home expansion, then the path is taken literally
//   '/abs/path/名称.png' → absolute path
//   'desktop/名称.png'  → token: app.getPath('desktop') on ANY platform, so a
//                         localized XDG folder (`~/桌面`) is reached without
//                         the model knowing its name; documents/, downloads/
//                         and pictures/ work the same way
//   'shots/a.png'       → relative paths start from Downloads
// A path that names an existing directory (or ends with a separator) gets an
// auto-named file inside it; missing parent folders are created by the caller.
//
// The ONE carve-out is the app's own data directory (`~/.pulsemind`): a NEW
// file under hooks/ or skills/ is not data, it is code/prompt content that the
// app executes or injects on the next launch, so "never overwrite" would not
// contain it. Everything else on the filesystem is fair game.
//
// Containment of that carve-out is LEXICAL: a symlink the user themselves
// placed inside the data dir is still followed. Creating one needs the user's
// own action — or `exec`, which in auto approval already has shell access.

import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export type ScreenshotSaveRequest = boolean | string

export const SCREENSHOT_ROOTS = ['downloads', 'desktop', 'documents', 'pictures'] as const
export type ScreenshotRoot = (typeof SCREENSHOT_ROOTS)[number]

/** The well-known folders, filled from `app.getPath`. `home` feeds `~/…`
 *  expansion; the other four back the token spellings. */
export interface ScreenshotDirs extends Record<ScreenshotRoot, string> {
  home: string
}

export interface ScreenshotDestination {
  /** Absolute directory; the caller creates it (recursive) before writing. */
  dir: string
  /** Exact basename for explicit paths; auto-named otherwise. */
  name: string
}

export interface ScreenshotSaveOptions {
  dirs: ScreenshotDirs
  now?: Date
  platform?: NodeJS.Platform
  /** Absolute roots that must never receive a screenshot (the app's own data
   *  dir). Lexical containment, host path semantics. */
  protectedRoots?: string[]
}

type PathApi = typeof posix

/** The host path module on purpose: a Windows process must compare drive
 *  letters/backslashes its own way. Tests pass `platform: 'win32'` to exercise
 *  the Windows rules from a POSIX host. */
function pathFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? win32 : posix
}

const MAX_STEM = 80
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif)$/i
// Windows cannot create files with these stems (with or without an extension).
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// `desktop/…` — a separator is required, so the bare name `desktop` stays a
// filename in Downloads.
const TOKEN_PATH_RE = /^(desktop|documents|downloads|pictures)[/\\]+(.*)$/i
// `C:name` is drive-relative; only `C:\…` or `C:/…` names a real place.
const DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Local-time stamp, millisecond precision: two screenshots in the same
 *  second must not collapse into one name. */
export function screenshotStamp(now: Date): string {
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    `${pad(now.getMilliseconds(), 3)}`,
  ].join('-')
}

function autoName(now: Date): string {
  return `pulsemind-screenshot-${screenshotStamp(now)}.png`
}

/** Sanitize a BARE filename (the legacy `save: '名称.png'` shape); an explicit
 *  path is used verbatim. Throws on a separator — silently basenaming would
 *  save somewhere else than asked. */
export function screenshotFileName(requested: ScreenshotSaveRequest, now: Date = new Date()): string {
  if (typeof requested !== 'string') return autoName(now)
  const raw = requested.trim()
  if (!raw) return autoName(now)
  if (/[/\\]/.test(raw)) {
    throw new Error(
      'screenshot 的文件名里不能包含路径分隔符。要指定目录，请直接给路径（例如 ~/Desktop/名称.png）。',
    )
  }
  // Control chars + Windows-illegal characters. A path separator already
  // threw above, so nothing here can redirect the write. The filter works by
  // codepoint rather than a regex class: \x00-\x1f in a pattern trips
  // no-control-regex, and the explicit set reads clearer anyway.
  const name = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f && !'<>:"|?*'.includes(ch)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots would create a hidden file; trailing dots/spaces are
    // silently stripped by Windows.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
  if (!name) return autoName(now)
  // Browser screenshots are always PNG; keep a PNG name, replace a named
  // image extension, append for anything else. `chart` → `chart.png`,
  // `chart.jpg` → `chart.png`, `report.final` → `report.final.png`.
  const stem = (name.replace(IMAGE_EXT_RE, '') || name).slice(0, MAX_STEM).replace(/[. ]+$/g, '')
  const safeStem = WINDOWS_RESERVED_RE.test(stem) ? `shot-${stem}` : stem || 'screenshot'
  return `${safeStem}.png`
}

function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A target inside a protected root is refused — even a NEW file: under the
 *  app's data dir, a fresh `hooks/app-start.js` or `skills/…/SKILL.md` is
 *  executed or injected on the next launch. `path.relative` gives win32 its
 *  case-insensitive compare and rejects a different drive as absolute. */
function assertNotProtected(file: string, roots: string[] | undefined, p: PathApi): void {
  for (const root of roots ?? []) {
    const rel = p.relative(p.resolve(root), file)
    const inside = rel === '' || (!p.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${p.sep}`))
    if (inside) {
      throw new Error(
        `截图不能保存到应用数据目录（${p.resolve(root)}）：该目录下的 hooks/、skills/ 等文件会影响应用的启动和提示词。` +
          `请换一个位置，例如 ~/Desktop/名称.png。`,
      )
    }
  }
}

/**
 * Turn the tool's `save` option into `{ dir, name }`. Missing parents are the
 * caller's to create; an existing file is the writer's to avoid.
 */
export function resolveScreenshotSave(
  requested: ScreenshotSaveRequest,
  options: ScreenshotSaveOptions,
  isDirectory: (path: string) => boolean = isDirectoryOnDisk,
): ScreenshotDestination {
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  const now = options.now ?? new Date()
  const dirs = options.dirs
  const downloads = p.resolve(dirs.downloads)
  const home = p.resolve(dirs.home)

  if (typeof requested !== 'string' || !requested.trim()) {
    return { dir: downloads, name: autoName(now) }
  }
  const raw = requested.trim()

  // Legacy shape: a BARE name (no separator) is a filename in Downloads.
  // `.`, `..`, `~` and `C:name` are path syntax, not names.
  if (
    !/[/\\]/.test(raw) &&
    raw !== '.' &&
    raw !== '..' &&
    raw !== '~' &&
    !(platform === 'win32' && DRIVE_RELATIVE_RE.test(raw))
  ) {
    return { dir: downloads, name: screenshotFileName(raw, now) }
  }

  let target: string
  const token = TOKEN_PATH_RE.exec(raw)
  if (token) {
    const root = token[1].toLowerCase() as ScreenshotRoot
    // `..` inside a token is ordinary path syntax now (no allowlist to launder).
    target = p.resolve(p.resolve(dirs[root]), token[2] || '.')
  } else if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const rest = raw.slice(1).replace(/^[/\\]+/, '')
    target = rest ? p.resolve(home, rest) : home
  } else if (p.isAbsolute(raw)) {
    target = p.resolve(raw)
  } else {
    if (platform === 'win32' && DRIVE_RELATIVE_RE.test(raw)) {
      throw new Error(
        `screenshot 的 save 收到盘符相对路径「${raw}」——请写完整路径（例如 C:\\Users\\你\\Desktop\\名称.png）或 ~/…。`,
      )
    }
    // Relative paths start from Downloads, the default destination.
    target = p.resolve(downloads, raw)
  }

  const asDir = raw === '~' || /[/\\]$/.test(raw) || isDirectory(target)
  const dir = asDir ? target : p.dirname(target)
  const name = asDir ? autoName(now) : p.basename(target)
  assertNotProtected(p.join(dir, name), options.protectedRoots, p)
  return { dir, name }
}

/**
 * Write the PNG without ever replacing an existing file. `wx` turns the
 * exists-check and the write into one atomic operation, so a file created
 * between two screenshots is still left alone; `-2`, `-3` … is appended to
 * the stem (the extension, if any, is preserved).
 */
export async function writeScreenshotFile(
  dest: ScreenshotDestination,
  data: Buffer,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const p = pathFor(platform)
  const ext = p.extname(dest.name)
  const stem = ext ? dest.name.slice(0, -ext.length) : dest.name
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? dest.name : `${stem}-${i}${ext}`
    const path = p.join(dest.dir, name)
    try {
      await writeFile(path, data, { flag: 'wx' })
      return path
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error(
    `截图失败：${dest.dir} 里同名文件过多，无法为「${dest.name}」找到可用的文件名。`,
  )
}
