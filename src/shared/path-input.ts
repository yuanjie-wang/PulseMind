// ── User-supplied path spelling ──
// A path that enters the app from outside is not always a plain filesystem
// path. Clipboard text, file managers, chat transcripts and model output all
// spell the same location as a `file:` URL: GNOME/UOS file managers use the
// single-slash shorthand `file:/home/x.png`, browsers use `file:///…`
// (`file://localhost/…` for the loopback host), and the app's own preview
// protocol is `local-file://…`.
//
// Every consumer of these strings resolves a non-absolute spelling against the
// session workspace, so an un-stripped URI becomes `<workspace>/file:/home/…`
// — a path that cannot exist. That is the 2026-11-10 UOS attachment failure:
// `[file:/home/…/x.png]` reached `ocr`, both resolvers joined it onto the
// workspace, and `stat` returned ENOENT for the joined spelling.
//
// One pure rule, no IO and no `node:path`: the renderer (attachment chips, tool
// argument resolution) and the main process (the sandbox gate, file-ops'
// resolvePath) must agree byte for byte — the guard judges the spelling the
// operation lands on, so two grammars would mean two answers.

const FILE_URI_RE = /^(?:local-)?file:/i

/** `file:` / `local-file:` URI → local filesystem path, or null when the text
 *  is not a local file URI. Rejects multi-line text (a pasted paragraph that
 *  quotes a URL is not a path), non-local hosts (`file://server/share` is a
 *  remote share) and malformed percent-encoding; the caller keeps the original
 *  text in every null case, so a false positive can never eat it. */
export function fileUriToPath(text: string): string | null {
  if (/[\r\n]/.test(text)) return null
  const trimmed = text.trim()
  if (!FILE_URI_RE.test(trimmed)) return null
  let rest = trimmed.replace(FILE_URI_RE, '')

  // Authority form — after the scheme: `//host/path` (browser), `///path`
  // (empty host), `//C:/path` (a Windows drive sitting in the host slot). Any
  // other non-empty host is a remote share, not a path on this machine.
  if (rest.startsWith('//')) {
    rest = rest.slice(2)
    const slash = rest.indexOf('/')
    if (slash >= 0) {
      const host = rest.slice(0, slash)
      if (host === '' || host.toLowerCase() === 'localhost') rest = rest.slice(slash)
      else if (/^[A-Za-z]:$/.test(host)) rest = host + rest.slice(slash)
      else return null
    } else if (!/^([A-Za-z]:)?$/.test(rest)) return null
  }

  // `/C:/…` → `C:/…` (browser spelling of a Windows path), then collapse the
  // repeated slashes a `file:////…` spelling leaves behind.
  if (/^\/[A-Za-z]:\//.test(rest)) rest = rest.slice(1)
  rest = rest.replace(/^\/{2,}/, '/')

  // Only an absolute result counts. `file:notes.txt` / `file: see attachment`
  // are prose, not paths — a paste of plain text must never lose its text to a
  // chip attempt (the paste handler preventDefaults once it believes it has a
  // path).
  if (!rest.startsWith('/') && !rest.startsWith('\\\\') && !/^[A-Za-z]:[\\/]/.test(rest)) return null

  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null // malformed percent-encoding is not a path we can trust
  }
  return rest || null
}

/** The boundary rule: a local file URI becomes its filesystem path, every
 *  other spelling is returned byte-identical — bare relative paths included,
 *  since they legitimately mean workspace-relative. Idempotent. */
export function normalizePathInput(input: string): string {
  return fileUriToPath(input) ?? input
}
