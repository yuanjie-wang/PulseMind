// ── Ripgrep plumbing for knowledge search (raw store + wiki queries) ──
// One binary resolver and one output parser shared by both search sites, so
// they cannot drift. Packaged builds MUST resolve the bundled binary — rg is
// not on a packaged app's PATH — while bare 'rg' keeps dev machines and Linux
// distros with a system ripgrep working.

import { getBundledRipgrepPath } from '../services/platform-info'

/** rg executable: the bundled ripgrep first, PATH 'rg' as fallback. */
export function ripgrepBinary(): string {
  return getBundledRipgrepPath() ?? 'rg'
}

export interface RgLine {
  absPath: string
  lineNum: number
  content: string
}

/** Parse one `rg --no-heading -n` output line (`path:line:content`).
 *  Windows paths carry a drive colon (`C:\...`), so the line cannot be split
 *  at the FIRST colon — the `:<digits>:` separator after the path is matched
 *  instead, which a drive colon (not followed by digits) can never satisfy. */
export function parseRgLine(line: string): RgLine | null {
  const match = /^(.+?):(\d+):/.exec(line)
  if (!match) return null
  return {
    absPath: match[1],
    lineNum: parseInt(match[2], 10) || 0,
    content: line.slice(match[0].length).trim(),
  }
}
