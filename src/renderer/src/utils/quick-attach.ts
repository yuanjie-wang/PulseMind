/**
 * Quick-attach parsing (paste / drag-drop into the composer) — pure logic,
 * no DOM globals beyond the structural types below, so vitest can drive it.
 *
 * Everything here feeds InputArea's existing attachment state
 * (selectedFiles / selectedFolders → `[file:]` / `[folder:]` markers), so a
 * pasted or dropped path lands exactly like the file-picker buttons.
 */

import { fileUriToPath } from '../../../shared/path-input'

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

/** Single-line `file:` URL text → filesystem path; anything else → null.
 *  The URI grammar itself (two/three slashes, the single-slash `file:/home/…`
 *  shorthand GNOME/UOS file managers hand out, the `local-file:` alias,
 *  percent-encoding, Windows drives, `localhost`) lives in shared/path-input —
 *  the main process's sandbox gate strips the same forms, and two grammars
 *  would mean two answers for one string. A bare filesystem path stays null:
 *  pasted text that already is a path is left as text, since only the user
 *  knows whether they meant to attach it. */
export function fileUrlToPath(text: string): string | null {
  return fileUriToPath(text)
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
