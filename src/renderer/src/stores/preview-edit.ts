// ── Preview edit pure layer (PLAN-preview-edit T1) ──
// EOL/BOM preservation, dirty determination and the external-change decision,
// all as pure functions so the store and the components stay thin and the
// semantics are unit-testable. The DOM textarea normalizes whatever `value`
// it is given to LF on read — saving that straight back would turn a CRLF
// file into LF file-wide (svcEditFile already guards this main-side; this is
// the renderer-side twin, D6).

export type Eol = '\r\n' | '\n'

/** The file's dominant line ending: any CRLF anywhere makes it a CRLF file. */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function applyEol(text: string, eol: Eol): string {
  if (eol === '\r\n') return text.replace(/\r?\n/g, '\r\n')
  return text.replace(/\r\n/g, '\n')
}

export function stripBom(text: string): { text: string; hadBom: boolean } {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), hadBom: true } : { text, hadBom: false }
}

export function restoreBom(text: string, hadBom: boolean): string {
  return hadBom ? '\uFEFF' + text : text
}

/** One open draft. `content` is the LF-normalized edited text; `baseline` is
 *  the on-disk text (also LF-normalized) the edit started from; `diskText` is
 *  the disk text EXACTLY as read — the write gate compares raw bytes, and a
 *  CRLF/BOM file's normalized baseline never equals them, which made every
 *  save of such a file refuse with "externally modified" forever (H8). */
export interface DraftEntry {
  content: string
  baseline: string
  /** Raw disk text (BOM/CRLF intact) — the expectContent of the first save. */
  diskText: string
  eol: Eol
  bom: boolean
}

/** Build a draft from freshly read disk text: BOM stripped, EOL detected and
 *  normalized away — both restored on save. */
export function makeDraftFromDisk(diskText: string): DraftEntry {
  const { text, hadBom } = stripBom(diskText)
  const eol = detectEol(text)
  const baseline = applyEol(text, '\n')
  return { content: baseline, baseline, diskText, eol, bom: hadBom }
}

/** Dirty compares the edited text to the baseline — both LF-normalized, so
 *  EOL/BOM never make a clean file look dirty. */
export function isDirty(entry: DraftEntry): boolean {
  return entry.content !== entry.baseline
}

export type ConflictDecision = 'silent-refresh' | 'conflict' | 'same'

/**
 * What to do when the file was re-read after an agent write (D7):
 * - clean draft → adopt the new disk text without ceremony;
 * - dirty and disk moved off our baseline → conflict banner (the two choices
 *   belong to the user);
 * - dirty but disk equals our baseline (the agent changed the file and changed
 *   it back) → not a conflict; the draft stays valid as-is.
 */
export function conflictDecision(dirty: boolean, diskText: string, baseline: string): ConflictDecision {
  if (!dirty) return 'silent-refresh'
  return applyEol(stripBom(diskText).text, '\n') === baseline ? 'same' : 'conflict'
}

/** >1MB disables editing (D8) — a textarea rendering megabytes stalls the pane. */
export const MAX_EDITABLE_BYTES = 1024 * 1024

export function isEditableSize(byteLength: number): boolean {
  return byteLength <= MAX_EDITABLE_BYTES
}

/** Serialize a draft back to disk bytes: edited text, original EOL, original BOM. */
export function serializeDraft(entry: DraftEntry): string {
  return restoreBom(applyEol(entry.content, entry.eol), entry.bom)
}
