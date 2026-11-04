/** Agent-review diff baseline reconstruction (2026-11-01 pivot; hardened
 *  2026-11-03, review_20261103 中3/中4/中5).
 *
 * When the preview pane did NOT hold a file an agent just edited, the edit's
 * own old_str/new_str rebuild the pre-change text from the fresh disk copy so
 * the VIEW-mode merge review can show "what the agent changed" (no accept /
 * reject controls — user ruling). Production used to inline this expression
 * and the unit test hand-copied it — the copy stayed green while the real
 * code carried two true defects, so the logic now lives here and BOTH sides
 * import it (same-source discipline; also edit-similarity's patch-utils
 * rationale).
 *
 * Three rules beyond a plain `replace`:
 *  - `$` in the replacement is DATA, not a pattern: `'a$$2b'.replace('$$2',
 *    '$$1')` returns 'a$1b' because String.replace interprets `$&`/`` $` ``/
 *    `$'`/`$$` inside the REPLACEMENT string — bash `$$` / ANSI-C `$'…'` /
 *    Makefile `$$` hit exactly this and the review diff silently showed a
 *    wrong "before" text. The single arm replaces through a function; the
 *    multiAll arm (split/join) never interpreted patterns to begin with.
 *  - An empty half returns `after` unchanged = an honest empty diff:
 *    `replace('', x)` splices x between the head and the first character and
 *    `split('')` splits between EVERY character — document-scale fake diffs.
 *    (oldStr emptiness is already refused by the sync capture guard; newStr
 *    emptiness is a LEGAL pure-deletion edit, so it is handled here too.)
 *  - CRLF files: the model sends LF-shaped old_str/new_str, so against a CRLF
 *    disk copy multi-line needles never matched and every review fell back to
 *    "unchanged" on Windows-authored files. Normalize all three strings to LF
 *    for the match, then restore the file's own CRLF — the same tolerance the
 *    main-side editFile applies (match normalized, write back CRLF). A
 *    no-newline edit is unaffected (nothing to normalize, matches either way).
 */

export interface ReconstructSpec {
  oldStr: string
  newStr: string
  /** edit's `multi: true` — every occurrence comes back, not just the first. */
  multiAll: boolean
}

export function reconstructPreChangeText(after: string, spec: ReconstructSpec): string {
  const { oldStr, newStr, multiAll } = spec
  if (!oldStr || !newStr) return after
  const isCRLF = after.includes('\r\n')
  const afterNorm = isCRLF ? after.replace(/\r\n/g, '\n') : after
  const oldNorm = isCRLF ? oldStr.replace(/\r\n/g, '\n') : oldStr
  const newNorm = isCRLF ? newStr.replace(/\r\n/g, '\n') : newStr
  const before = multiAll ? afterNorm.split(newNorm).join(oldNorm) : afterNorm.replace(newNorm, () => oldNorm)
  return isCRLF ? before.replace(/\n/g, '\r\n') : before
}
