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

/** The rg argv for a knowledge content search (wiki + raw store — ONE builder
 *  so the two channels cannot drift). The query is ALWAYS consumed as a VALUE:
 *  `-e` puts it where option parsing cannot reach — a bare positional query
 *  like `--pre=/bin/sh` made rg run a program on every searched file
 *  (full_20261011 M10-P0-1, measured with the repo's own rg 14.1.1) — and `--`
 *  terminates option parsing before the search dir. Multi-word queries OR
 *  their terms fixed-string; a single term is one fixed-string pattern. */
export function buildRgSearchArgs(
  query: string,
  dir: string,
  base: string[] = ['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count', '5'],
): string[] {
  const terms = query.split(/\s+/).filter(Boolean)
  const args = [...base, '-F']
  for (const t of terms) args.push('-e', t)
  args.push('--', dir)
  return args
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
