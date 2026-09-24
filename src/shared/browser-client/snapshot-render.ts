// ── ARIA tree rendering + trimming (PLAN-browser-snapshot-ai §1.1) ──
// The AI-mode JSON tree is rendered into YAML HERE, not by Playwright, so the
// full view and the diff view share one formatter and can never drift. The
// trimming rules apply at render time against the SAME tree both views read:
//   • node name  → 80 chars
//   • MAX_REF_NODES ref-bearing nodes — beyond that an explicit truncation
//     declaration (the old「说不截」contract: the output says what was cut)
//   • url/cursor/box and other decoration keys are dropped (state-block budget)

export interface AriaNode {
  role: string
  name?: string
  ref?: string
  children?: AriaNode[]
}

/** The ref cap — mirrors the old MAX_REF_ELEMENTS(200) intent, doubled because
 *  the AI engine addresses generic containers too (plan §一.2: 可寻址面扩大). */
export const MAX_REF_NODES = 400

const NAME_MAX = 80

function clean(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
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
    lines.push(head)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)

  if (truncated) {
    lines.push(`（页面过大：仅渲染前 ${MAX_REF_NODES} 个带编号节点——缩小范围、用页面内检索，或对局部元素 ariaSnapshot 后再 domSnapshot）`)
  }
  return lines.join('\n')
}
