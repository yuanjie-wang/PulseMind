// ── openExternal scheme gate (review 2026-09-25, P0-2) ──
// shell.openExternal hands a URL to the OS launcher: an arbitrary scheme
// means smb:// shares, custom app protocols, file:///.command and friends.
// Every main-side openExternal call funnels through `safeExternalUrl`, which
// returns the URL to open or null (deny). Pure by design — dataDir is a
// parameter, so this file imports no Electron/Node state and tests cover it
// directly.
//
// Policy:
//   http/https/mailto/chrome — the ordinary link schemes (chrome: is the
//     settings page's "open extensions page" button).
//   file — only for app-managed data files: the path must resolve INSIDE
//     dataDir (html cards persist under dataDir/tmp/html-cards, knowledge
//     sources under dataDir/knowledge) AND must not carry an executable
//     extension. The extension deny-list is deliberately conservative on
//     Windows (WSH scripts run under `start`); it is a second layer, the
//     dataDir containment is the primary one.
//   everything else — null.

/** Windows/WSH/macOS launchable extensions never opened via file:. */
const FILE_EXEC_DENY_EXTS = new Set([
  // Windows: ShellExecute/WSH runs these directly
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psc1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.scr', '.msi', '.msp', '.jar',
  '.jnlp', '.cpl', '.reg', '.inf', '.lnk', '.url', '.application', '.gadget',
  // macOS: LaunchServices executes these
  '.command', '.app', '.pkg', '.dmg', '.workflow', '.applescript', '.scptd',
])

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'chrome:'])

/** Lexically resolve `.`/`..` segments — the URL parser will not do it for
 *  us: on Node 20 a literal `..` after a dot-prefixed segment survives
 *  (`/data/.pulsemind/../../etc/passwd` keeps its `..`), and an encoded
 *  `..%2f` decodes into a traversal the prefix check can't see. The
 *  containment check must judge where the OS will actually open the file, so
 *  the path is resolved HERE, after the shorthand mapping. A `%2f` is already
 *  decoded by this point and counts as a separator, matching how file URLs
 *  are percent-decoded before path resolution. Traversal past root clamps at
 *  root (popping an empty stack is a no-op). */
function resolveDotSegments(pathname: string): string {
  const absolute = pathname.startsWith('/')
  const out: string[] = []
  for (const seg of pathname.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return absolute ? '/' + joined : joined
}

/** Map the renderer's `file:///.pulsemind/...` shorthand onto an absolute path. */
function normalizeFileUrl(url: URL, dataDir: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // Windows file URLs: file:///C:/x → /C:/x → C:/x
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
  // file:///.pulsemind/foo (the shorthand svcCopyFile also accepts)
  if (pathname.startsWith('/.pulsemind/') || pathname === '/.pulsemind') {
    pathname = dataDir + pathname.slice('/.pulsemind'.length)
  }
  pathname = resolveDotSegments(pathname)
  // A NUL truncates the path on Win32: `note.command%00.html` would pass an
  // extension check on `.html` and open as note.command. No such file can
  // exist anyway, so refuse rather than guess.
  if (pathname.includes('\0')) return null
  return pathname
}

function isInside(root: string, target: string): boolean {
  const normRoot = root.replace(/[\\/]+$/, '')
  const normTarget = target.replace(/[\\/]+$/, '')
  if (normTarget === normRoot) return true
  const sep = normRoot.includes('\\') ? '\\' : '/'
  return normTarget.startsWith(normRoot + sep)
}

/** Validate a filesystem path destined for `shell.openPath` (full_20261011
 *  M8-F4): openPath hands the path to LaunchServices/ShellExecute, which
 *  LAUNCHES `.app`/`.command` on macOS and `.exe`/`.lnk`/`.bat` on Windows —
 *  and the callers (preview pane, file chips) pass model-influenced paths.
 *  Same executable deny-list as the file: scheme above. Containment is
 *  deliberately NOT applied: those buttons also open files the USER picked
 *  anywhere on disk (attachments), so the deny-list is the gate. Returns the
 *  path or null (deny). */
export function safeOpenPath(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  if (raw.includes('\0')) return null
  const dot = raw.lastIndexOf('.')
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  if (dot > slash && FILE_EXEC_DENY_EXTS.has(raw.slice(dot).toLowerCase())) return null
  return raw
}

/**
 * Validate a URL destined for `shell.openExternal`.
 * Returns the (possibly normalized) URL, or null when it must not be opened.
 */
export function safeExternalUrl(raw: string, dataDir: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (ALLOWED_SCHEMES.has(url.protocol)) return url.href

  if (url.protocol === 'file:') {
    const path = normalizeFileUrl(url, dataDir)
    if (!path) return null
    if (!isInside(dataDir, path)) return null
    const dot = path.lastIndexOf('.')
    if (dot > 0 && FILE_EXEC_DENY_EXTS.has(path.slice(dot).toLowerCase())) return null
    return url.href
  }

  return null
}
