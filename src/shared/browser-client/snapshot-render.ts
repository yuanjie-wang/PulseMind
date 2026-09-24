// ── ARIA tree rendering + trimming (PLAN-browser-snapshot-ai §1.1) ──
// The AI-mode JSON tree is rendered into YAML HERE, not by Playwright, so the
// full view and the diff view share one formatter and can never drift. The
// trimming rules apply at render time against the SAME tree both views read:
//   • node name  → 80 chars
//   • MAX_REF_NODES ref-bearing nodes — beyond that an explicit truncation
//     declaration (the old「说不截」contract: the output says what was cut)
//   • ACTIONABLE state keys render as brackets (checked/disabled/selected/
//     level/url≤40 — a snapshot that cannot show a checkbox state makes
//     check/uncheck unverifiable, and the diff blind to it); the pure-noise
//     keys (active/cursor/box) are dropped (state-block budget)

export interface AriaNode {
  role: string
  name?: string
  ref?: string
  children?: AriaNode[]
  /** Actionable state the AI engine carries. The renderer shows them and the
   *  diff folds them into the feature tuple — a check toggle IS a change. */
  checked?: boolean | 'mixed'
  disabled?: boolean
  selected?: boolean
  level?: number
  url?: string
}

/** The ref cap — mirrors the old MAX_REF_ELEMENTS(200) intent, doubled because
 *  the AI engine addresses generic containers too (plan §一.2: 可寻址面扩大). */
export const MAX_REF_NODES = 400

const NAME_MAX = 80
const URL_MAX = 40

function clean(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
}

/** The bracket decorations a node carries, in render order — the ONE formatter
 *  both the full view and the diff entries use, so a state can never render
 *  two ways. Absent/false renders nothing ([checked] only marks ON, like
 *  Playwright's own YAML). */
export function decorateNode(node: Pick<AriaNode, 'checked' | 'disabled' | 'selected' | 'level' | 'url'>): string {
  const out: string[] = []
  if (node.checked === 'mixed') out.push('[mixed]')
  else if (node.checked === true) out.push('[checked]')
  if (node.disabled) out.push('[disabled]')
  if (node.selected) out.push('[selected]')
  if (typeof node.level === 'number') out.push(`[level=${node.level}]`)
  if (typeof node.url === 'string' && node.url) {
    out.push(`[url=${node.url.length > URL_MAX ? node.url.slice(0, URL_MAX) + '…' : node.url}]`)
  }
  return out.join(' ')
}

/** Render the trimmed YAML. Returns the text and the refs that survived (the
 *  caller stores the FULL tree for diffing; the surviving-ref list is for the
 *  truncation declaration only). */
export function renderAriaTree(roots: AriaNode[]): string {
  const lines: string[] = []
  let refCount = 0
  let truncated = false

  const walk = (node: AriaNode, depth: number): void => {
    if (truncated) return
    const indent = '  '.repeat(depth)
    const name = clean(node.name)
    let head = `${indent}- ${node.role}`
    if (name) head += ` "${name.length > NAME_MAX ? name.slice(0, NAME_MAX) + '…' : name}"`
    if (node.ref) {
      if (refCount >= MAX_REF_NODES) {
        truncated = true
        return
      }
      refCount++
      head += ` [ref=${node.ref}]`
    }
    const deco = decorateNode(node)
    if (deco) head += ` ${deco}`
    lines.push(head)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)

  if (truncated) {
    lines.push(`（页面过大：仅渲染前 ${MAX_REF_NODES} 个带编号节点——缩小范围、用页面内检索，或对局部元素 ariaSnapshot 后再 domSnapshot）`)
  }
  return lines.join('\n')
}
