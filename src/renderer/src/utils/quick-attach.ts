/**
 * Quick-attach parsing (paste / drag-drop into the composer) — pure logic,
 * no DOM globals beyond the structural types below, so vitest can drive it.
 *
 * Everything here feeds InputArea's existing attachment state
 * (selectedFiles / selectedFolders → `[file:]` / `[folder:]` markers), so a
 * pasted or dropped path lands exactly like the file-picker buttons.
 */

/**
 * Structural shape for a clipboard/drag file: `type` for MIME sniffing.
 * `path` is NOT a runtime fact on Electron 33 — the ambient d.ts still
 * declares it but a real File reads `undefined` (the disk path comes from
 * `electronAPI.getPathForFile`); the optional field survives only for
 * fixtures/older Electron. Kept structural so this module stays free of the
 * Electron ambient types.
 */
export interface ElectronFile {
  path?: string
  type?: string
}

/** Single-line `file:///…` text → filesystem path; anything else → null.
 *  Handles percent-encoding, Windows `file:///C:/…`, and tolerates trailing
 *  whitespace (callers trim first anyway). Multi-line text is never a path. */
export function fileUrlToPath(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.includes('\n')) return null
  if (!/^file:\/\//i.test(trimmed)) return null
  let rest = trimmed.replace(/^file:\/\//i, '')
  // file://host/path — only an empty host, `localhost`, or a bare Windows
  // drive (`file://C:/…`, where the "host" IS the drive letter) is local; any
  // other host is a remote share. The drive spelling must keep its letter, so
  // it is re-attached rather than sliced off with the host.
  const slash = rest.indexOf('/')
  if (slash > 0) {
    const host = rest.slice(0, slash)
    if (host === 'localhost') rest = rest.slice(slash)
    else if (/^[A-Za-z]:$/.test(host)) rest = host + rest.slice(slash)
    else return null
  }
  if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1) // file:///C:/… → /C:/… → C:/…
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null // malformed percent-encoding is not a path we can trust
  }
  return rest || null
}

/** Merge incoming paths into an existing list, de-duplicated (first wins). */
export function mergeAttachments(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing)
  const out = [...existing]
  for (const p of incoming) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Image MIME types worth saving through `saveBase64Image` when a pasted
 *  clipboard item has no backing path (screenshot case). */
export function isImageFile(file: ElectronFile): boolean {
  return (file.type ?? '').startsWith('image/')
}
