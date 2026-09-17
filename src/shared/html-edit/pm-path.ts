// ── pmPath: the element identity shared by the in-frame picker and the
// parent-side resolver (PLAN-html-element-edit D4) ──
// A pmPath names an element by its tag name plus its position among ELEMENT
// siblings only ('html>body>div:nth-child(2)>h1:nth-child(1)'). Both sides
// must count the same way: text/comment nodes are invisible to the index,
// and the picker's own injected nodes (the script and the overlay host) are
// excluded so the injected preview copy and the untouched disk source agree.

/** 1-based position among element siblings (the nth-element-child index). */
export interface PmPathSegment {
  tag: string
  index: number
}

/** The picker's injected nodes — never selectable, never counted in indices. */
export const PM_PICKER_SCRIPT_ID = 'pm-picker-script'
export const PM_PICKER_HOST_ID = 'pm-picker-host'

/** Format `html>body>div:nth-child(2)>h1:nth-child(1)` — every non-root
 *  segment carries its index so formatting is byte-stable. A bare segment
 *  (`html>body`) still parses, with the index defaulting to 1. */
export function formatPmPath(segments: PmPathSegment[]): string {
  return segments
    .map((seg, i) => (i === 0 ? seg.tag : `${seg.tag}:nth-child(${seg.index})`))
    .join('>')
}

/** Parse a pmPath back into segments. Returns null on any malformed input —
 *  callers refuse to patch rather than guess (D6). */
export function parsePmPath(path: string): PmPathSegment[] | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const segments: PmPathSegment[] = []
  for (const raw of trimmed.split('>')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?::nth-child\((\d+)\))?$/.exec(raw.trim())
    if (!match) return null
    const index = match[2] ? parseInt(match[2], 10) : 1
    if (index < 1) return null
    segments.push({ tag: match[1].toLowerCase(), index })
  }
  return segments.length > 0 ? segments : null
}

/** Parent-side walk over a parse5 tree: element children of a node. parse5
 *  nodes are plain objects — an element is any node carrying `tagName`. */
export function parse5ElementChildren(node: {
  childNodes?: { tagName?: string }[]
}): { tagName: string; sourceCodeLocation?: unknown }[] {
  return (node.childNodes ?? []).filter((child): child is { tagName: string } => typeof child.tagName === 'string')
}

/** Drop the last segment — the pmPath of the parent element. */
export function parentPmPath(path: string): string | null {
  const segments = parsePmPath(path)
  if (!segments || segments.length <= 1) return null
  return formatPmPath(segments.slice(0, -1))
}
