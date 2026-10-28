/**
 * Edit-miss recovery hints (PLAN-coding-contract, harness 反馈层).
 *
 * `old_str not found in <path>` used to be the ENTIRE error surface when an
 * edit's anchor text missed the file — zero information about where the file
 * actually holds similar code, so the model's next move was re-reading the
 * whole file or guessing a second old_str blind. This module locates the
 * closest matching region and puts its line numbers and verbatim text into
 * the error itself, so one failed edit carries the data for a correct retry:
 * a whitespace-only mismatch (the most common miss — the model reproduces
 * code from memory with its own indentation) is called out as such; a partial
 * match reports how many lines line up; a needle whose lines appear nowhere
 * says so, which usually means the wrong file.
 *
 * Pure and zero-import (patch-utils discipline): file-ops (main) and
 * patch-utils (shared, also parsed by the renderers' diff views) both call
 * it, so the hint semantics cannot drift between string-edit and diff-hunk
 * failures.
 *
 * Read-copy detection (B12, review 2026-10-28): `read` prints every content
 * line with an absolute `N\t` prefix (cat -n style), and a needle pasted
 * verbatim from that output misses twice — the exact match, then even the
 * trimmed similarity gate (the number survives trim mid-line) — landing in
 * the "None of old_str's lines appear — wrong file?" branch while the tool
 * itself just printed those prefixes. Both error constructors therefore try
 * the de-numbered needle first and NAME the prefix when, and only when, the
 * bare text actually matches the file; a needle whose lines genuinely look
 * like `N\t` (TSV data) or that is wrong beyond the prefixes falls through
 * to the honest normal wording.
 */

export interface SimilarRegion {
  /** 1-based, inclusive */
  startLine: number
  endLine: number
  /** needle lines matching at this position (whitespace-insensitive) */
  matchedLines: number
  totalLines: number
  /** every needle line matches once surrounding whitespace is ignored — the miss is indentation / invisible characters */
  whitespaceOnly: boolean
  /** The region cleared the cheap gate (at least one needle line exists
   *  verbatim in the file) but fell under the quality bar — resemblance is
   *  real yet fragmentary, and callers must NOT word this as "nothing
   *  matched": the gate just proved some lines DO appear, and that claim
   *  steers the model toward the wrong-file dead end. */
  fragmentary?: boolean
  /** verbatim file text at the region, line-numbered and capped */
  preview: string
}

const PREVIEW_MAX_LINES = 12
const PREVIEW_MAX_LINE_CHARS = 200

/** read's per-line coordinate prefix: a `%6d\t` field, so leading spaces are
 *  the number field's own right-alignment (a 7-digit line number needs none). */
const READ_NUMBERING_RE = /^\s*\d+\t/

/** The needle with read's `N\t` prefixes stripped from every line, or null
 *  when the shape is not a verbatim read copy (ANY line without a prefix).
 *  Returns a HINT CANDIDATE only — callers must confirm the stripped text
 *  actually matches the file before blaming the prefix, so genuinely `N\t`-
 *  shaped content (TSV) is never misdiagnosed: a TSV needle that exists in
 *  the file matches exactly upstream and never reaches the error path, and
 *  one that does not exist strips to text that also does not match, which
 *  falls through to the normal diagnosis. */
export function stripReadNumbering(needle: string): string | null {
  const lines = needle.split('\n')
  if (!lines.every((l) => READ_NUMBERING_RE.test(l))) return null
  return lines.map((l) => l.replace(READ_NUMBERING_RE, '')).join('\n')
}

export function findSimilarRegion(content: string, needle: string, previewMaxLines = PREVIEW_MAX_LINES): SimilarRegion | null {
  const fileLines = content.split('\n')
  const needleLines = needle.split('\n')
  const total = needleLines.length
  const n = fileLines.length
  if (total === 0 || n === 0 || needle.trim() === '') return null

  // Cheap gate before the O(n·m) scan: at least one trimmed needle line must
  // exist in the file, or no window can score a single match anywhere.
  const fileTrim = new Set(fileLines.map((l) => l.trim()))
  if (!needleLines.some((l) => fileTrim.has(l.trim()))) return null

  let bestStart = -1
  let bestHits = 0
  for (let i = 0; i < n; i++) {
    const span = Math.min(total, n - i)
    let hits = 0
    for (let j = 0; j < span; j++) {
      if (fileLines[i + j].trim() === needleLines[j].trim()) hits++
    }
    // Absolute hit count wins; ties keep the EARLIEST region (the first
    // occurrence is the likeliest edit target when several look alike).
    if (hits > bestHits) {
      bestHits = hits
      bestStart = i
      if (hits === total) break // a fully-trimmed-matching window cannot be beaten
    }
  }
  // Quality bar: a region whose only resemblance is a shared closing brace
  // ("1/3 lines line up") is noise dressed as guidance — a NULL here would
  // claim nothing matched at all. But the cheap gate already proved at least
  // one needle line exists verbatim, so a sub-bar scan returns the fragment
  // flagged `fragmentary` instead: callers say "partial resemblance, no
  // aligned region", which is honest about both facts. (Half the needle lines
  // (≥2) must line up for a real region; a single-line needle matching at all
  // IS the hit — that is the whitespaceOnly case.)
  const minHits = total === 1 ? 1 : Math.max(2, Math.ceil(total / 2))
  if (bestStart < 0) return null
  const fragmentary = bestHits < minHits

  const end = bestStart + Math.min(total, n - bestStart) // exclusive
  const windowLen = end - bestStart
  const fmtLine = (k: number): string => {
    const raw = fileLines[bestStart + k]
    const clipped = raw.length > PREVIEW_MAX_LINE_CHARS ? `${raw.slice(0, PREVIEW_MAX_LINE_CHARS)}…` : raw
    return `  ${bestStart + k + 1} | ${clipped}`
  }
  // Oversized windows preview head AND tail — the differing line sits as often
  // at the bottom of a long needle as at the top; a head-only cap would hide
  // exactly the line the model needs to see.
  const previewLines: string[] = []
  if (windowLen <= previewMaxLines) {
    for (let k = 0; k < windowLen; k++) previewLines.push(fmtLine(k))
  } else {
    const head = Math.ceil((previewMaxLines - 1) / 2)
    const tail = previewMaxLines - 1 - head
    for (let k = 0; k < head; k++) previewLines.push(fmtLine(k))
    previewLines.push(`  … (+${windowLen - head - tail} more lines)`)
    for (let k = windowLen - tail; k < windowLen; k++) previewLines.push(fmtLine(k))
  }

  return {
    startLine: bestStart + 1,
    endLine: end,
    matchedLines: bestHits,
    totalLines: total,
    whitespaceOnly: bestHits === total,
    fragmentary,
    preview: previewLines.join('\n'),
  }
}

/** The full edit tool's not-found error: the old one-liner plus the closest
 *  region's location and verbatim text, so the retry needs no fresh read. */
export function editMissError(filePath: string, normalizedContent: string, oldStr: string): string {
  const base = `old_str not found in ${filePath}`
  // A verbatim read copy misses even the trimmed gate, so without this branch
  // it is diagnosed as "wrong file". Only a stripped needle that really lands
  // in the file earns the prefix accusation (see stripReadNumbering).
  const stripped = stripReadNumbering(oldStr)
  if (stripped !== null) {
    const strippedRegion = findSimilarRegion(normalizedContent, stripped)
    if (strippedRegion && !strippedRegion.fragmentary) {
      const where = `lines ${strippedRegion.startLine}–${strippedRegion.endLine}`
      return `${base}. Every line of old_str still carries read's \`N\\t\` line-number prefix — read prints it as a coordinate (cat -n style), it is NOT part of the file, and a prefixed old_str can never match. Strip the prefixes and retry with the bare text, which matches at ${where}:\n${strippedRegion.preview}`
    }
  }
  const region = findSimilarRegion(normalizedContent, oldStr)
  if (!region) {
    return `${base}. None of old_str's lines appear in the file (ignoring leading/trailing whitespace) — you may be targeting the wrong file, or the code differs more than expected. Re-read the target file to find the actual text before retrying.`
  }
  const where = `lines ${region.startLine}–${region.endLine}`
  if (region.fragmentary) {
    // Some needle lines DO exist (the gate proved it) but no aligned region
    // cleared the quality bar — typically the needle was re-created from
    // memory and drifted (an extra/remembered line shifting everything).
    // Claiming "none of the lines appear" here would send the model off to
    // re-read the wrong file.
    return `${base}. Only ${region.matchedLines}/${region.totalLines} of old_str's line(s) appear in the file (fragmentary resemblance — no aligned region; the surrounding lines differ). You may be re-creating the code from memory: re-read ${where} and retry with old_str copied verbatim from the file, or pass a unified diff via the \`diff\` parameter — hunks re-anchor on context, not exact text. Closest fragment:\n${region.preview}`
  }
  if (region.whitespaceOnly) {
    return `${base}. A match EXISTS at ${where}: all ${region.totalLines} line(s) are identical once surrounding whitespace is ignored, so the miss is indentation or invisible characters. Retry with old_str copied verbatim from the file (or pass a unified diff via the \`diff\` parameter — hunks re-anchor on context, not exact text). Actual file content at ${where}:\n${region.preview}`
  }
  return `${base}. Closest matching region is at ${where}: ${region.matchedLines}/${region.totalLines} line(s) line up (ignoring surrounding whitespace). Actual file content there:\n${region.preview}\nRe-read that range and retry with old_str taken verbatim from the file, or pass a unified diff anchored on the lines above.`
}

/** The diff mode counterpart: a hunk whose context/removed lines do not match.
 *  Same hint family — the expected lines usually sit somewhere nearby, and the
 *  error now says where instead of leaving the line number to trust blindly. */
export function hunkMismatchError(oldStart: number, expectedLines: string[], content: string): string {
  const base = `Hunk at line ${oldStart} does not match file content. Expected different content in the target region.`
  if (expectedLines.length === 0) return base
  // Same read-copy trap as the string-edit miss: context/removed lines pasted
  // from read's numbered output carry `N\t` mid-line, invisible to both the
  // exact hunk match and the trimmed scan. Same discipline — only accuse the
  // prefix when the de-numbered expected lines actually sit in the file.
  const stripped = stripReadNumbering(expectedLines.join('\n'))
  if (stripped !== null) {
    const strippedRegion = findSimilarRegion(content, stripped)
    if (strippedRegion && !strippedRegion.fragmentary) {
      const where = `lines ${strippedRegion.startLine}–${strippedRegion.endLine}`
      return `${base} Every expected line still carries read's \`N\\t\` line-number prefix — a coordinate read prints, NOT part of the file, so the hunk can never match as sent. Rebuild the hunk from the bare text, which sits at ${where}:\n${strippedRegion.preview}`
    }
  }
  const region = findSimilarRegion(content, expectedLines.join('\n'))
  if (!region) {
    return `${base} None of the hunk's context/removed lines appear in the file — the hunk likely targets a stale line number or the wrong region. Re-read the file and regenerate the diff from the actual text.`
  }
  const where = `lines ${region.startLine}–${region.endLine}`
  if (region.fragmentary) {
    return `${base} Only ${region.matchedLines}/${region.totalLines} of the hunk's expected line(s) appear in the file (fragmentary resemblance — no aligned region; the surrounding lines differ). Re-read the file and regenerate the diff from the actual text. Closest fragment at ${where}:\n${region.preview}`
  }
  if (region.whitespaceOnly) {
    return `${base} The expected lines DO exist at ${where} (whitespace differs) — re-anchor the hunk on the exact text below:\n${region.preview}`
  }
  return `${base} The closest region to the hunk's expected content is at ${where} (${region.matchedLines}/${region.totalLines} line(s) line up):\n${region.preview}\nRe-read that range and regenerate the diff from the actual file text.`
}
