// ── Wiki page frontmatter helpers (PLAN-knowledge-base K3) ──
// Pure, shared by the main-process deletion path and the tests: whether a
// wiki page may be deleted when one of its sources goes away.

/** Parse a wiki page's `sources:` frontmatter into the raw path list.
 *  Accepts both block style (`sources:\n  - a.md`) and inline (`sources: [a.md]`). */
export function wikiPageSources(content: string): string[] {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) return []
  const end = trimmed.indexOf('---', 3)
  if (end === -1) return []
  const fm = trimmed.slice(3, end)
  const sources: string[] = []
  const inline = /^sources:\s*\[(.*)\]\s*$/m.exec(fm)
  if (inline) {
    sources.push(...inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean))
  } else {
    let inSources = false
    for (const line of fm.split('\n')) {
      if (/^sources:\s*$/.test(line)) { inSources = true; continue }
      if (inSources) {
        const item = /^\s+-\s*(.+)$/.exec(line)
        if (item) sources.push(item[1].trim().replace(/^["']|["']$/g, ''))
        else if (line.trim() !== '') inSources = false
      }
    }
  }
  return sources
}

/** Pure: can the wiki page at `wikiPath` be deleted when the source
 *  `removingRawPath` goes away? Safe only when NO other knowledge file still
 *  lists the page in its wiki_outputs AND every other source the page names
 *  still exists as a row (`existingRawPaths`) — a source that was already
 *  deleted cannot hold a page back (K3: the old unconditional unlink deleted
 *  merged pages that other sources still needed). */
export function wikiPageIsOrphan(
  content: string | null,
  wikiPath: string,
  removingRawPath: string,
  otherWikiOutputs: string[][],
  existingRawPaths: string[] = [],
): boolean {
  if (otherWikiOutputs.some((outputs) => outputs.includes(wikiPath))) return false
  if (content) {
    const alive = new Set(existingRawPaths)
    const sources = wikiPageSources(content)
    return sources.every((s) => s === removingRawPath || !alive.has(s))
  }
  return true
}
