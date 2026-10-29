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
 *  their terms fixed-string; a single term is one fixed-string pattern.
 *  Returns NULL for a whitespace-only query: `-e` + `--` is safe only while
 *  terms ≥ 1 — with zero `-e`, rg reads the first positional after `--` as the
 *  PATTERN, turning the search dir into a literal pattern and silently
 *  scanning the main process's CWD (review_20261015 中1, measured). Callers
 *  treat null as no results and must not spawn rg. */
export function buildRgSearchArgs(
  query: string,
  dir: string,
  base: string[] = ['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count', '5'],
): string[] | null {
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
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

/** True when execFile failed to RUN the search binary, as opposed to the binary
 *  reporting "no matches".
 *
 *  2026-10-29（recall 零命中复核）：storage 层的 rg/grep 通道原本一律
 *  `if (err && !stdout) resolve([])`，于是「rg 没装 / 起不来 / 被 timeout 杀掉」
 *  与「扫了、确实没命中」在上一层长得一模一样。recall 的 swallowSource 只认
 *  reject，永远等不到这条，零命中话术因此敢说「任何一个词都没出现过」——而其中
 *  可能只是检索引擎不可用。这个判定是那条记账能成立的前提。
 *
 *  rg/grep 的退出码语义：1 = 没有匹配（正常结束），2+ = 自身报错；spawn 失败
 *  （ENOENT/EACCES）与 maxBuffer 溢出给的是**字符串** code。err 为 null 即干净
 *  跑完，无论有没有命中都不算失败。 */
export function isSearchEngineFailure(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: string | number; killed?: boolean }
  if (typeof e.code === 'string') return true
  if (e.killed) return true
  return typeof e.code === 'number' && e.code !== 1
}
