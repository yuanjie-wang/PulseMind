// ── Snapshot diff (PLAN-browser-snapshot-ai §1.3) ──
// domSnapshot() defaults to the DIFF against the tab's last snapshot; the
// model escapes with `{ full: true }`. Diffs are anchored on refs — eN present
// on both sides with the same (role, name) is unchanged; a feature change is
// `~`, a new ref is `+`, a vanished ref is `-`. Refless structural nodes ride
// with their nearest ref-bearing ancestor: the diff never claims a change for
// a bare wrapper div, and a changed subtree is reported at the ref the model
// can address.
//
// Output shape is load-bearing: the model decides its next move off the last
// bytes of a tool result, so the diff block comes FIRST, unchanged material
// collapses to one line, and the escape hatch (`{full:true}`) is named.

import type { AriaNode } from './snapshot-render'

export interface DiffEntry {
  kind: '~' | '+' | '-'
  ref: string
  role: string
  name: string
  /** ref-bearing ancestor chain, top-down — tells the model WHERE on the page. */
  path: string[]
  /** For `~` entries: the name the previous snapshot showed. */
  oldName?: string
}

export interface DiffResult {
  entries: DiffEntry[]
  unchanged: number
}

interface IndexedNode {
  role: string
  name: string
  /** ref-bearing ancestors, top-down, excluding the node itself. */
  path: string[]
}

function indexTree(roots: AriaNode[]): Map<string, IndexedNode> {
  const index = new Map<string, IndexedNode>()
  const walk = (node: AriaNode, path: string[]): void => {
    const nextPath = node.ref ? [...path, node.ref] : path
    if (node.ref) {
      index.set(node.ref, { role: node.role, name: cleanName(node.name), path })
    }
    for (const child of node.children ?? []) walk(child, nextPath)
  }
  for (const root of roots) walk(root, [])
  return index
}

function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
}

/** Structural equality of what addressing cares about. A generic container
 *  whose name drifts by whitespace is NOT a change; a button whose label
 *  flipped IS. */
function sameFeature(a: IndexedNode, b: IndexedNode): boolean {
  return a.role === b.role && a.name === b.name
}

/** The ref-bearing ancestor chain of a ref, from the OTHER side's index when
 *  the node vanished (best effort — a `-` entry shows the old path). */
function pathOf(index: Map<string, IndexedNode>, ref: string): string[] {
  return index.get(ref)?.path ?? []
}

export function diffTrees(prev: AriaNode[], next: AriaNode[]): DiffResult {
  const before = indexTree(prev)
  const after = indexTree(next)
  const entries: DiffEntry[] = []
  let unchanged = 0

  for (const [ref, node] of after) {
    const old = before.get(ref)
    if (!old) {
      entries.push({ kind: '+', ref, role: node.role, name: node.name, path: node.path })
    } else if (!sameFeature(old, node)) {
      entries.push({ kind: '~', ref, role: node.role, name: node.name, path: node.path, oldName: old.name })
    } else {
      unchanged++
    }
  }
  for (const [ref, node] of before) {
    if (!after.has(ref)) {
      entries.push({ kind: '-', ref, role: node.role, name: node.name, path: pathOf(before, ref) })
    }
  }

  // Diff order: removals and changes first (they invalidate the model's
  // addressing), additions after.
  entries.sort((a, b) => (a.kind === '-' ? 0 : a.kind === '~' ? 1 : 2) - (b.kind === '-' ? 0 : b.kind === '~' ? 1 : 2))
  return { entries, unchanged }
}

/** The rendered diff block. Empty diff → one calm line (「无变化」 is itself a
 *  signal — it is the dead-link proof the plan cites). */
export function renderDiff(diff: DiffResult): string {
  if (diff.entries.length === 0) {
    return '── 与上次快照的差异 ──\n无变化（0 处）。若上一步动作没生效，这就是铁证——换定位器或检查 tabs.list()，不要重复同一动作。看全量：domSnapshot({ full: true })'
  }
  const lines: string[] = [`── 与上次快照的差异（${diff.entries.length} 处变化，其余 ${diff.unchanged} 个元素未变）──`]
  for (const e of diff.entries) {
    if (e.kind === '~') {
      lines.push(`~ [ref=${e.ref}] ${e.role} "${e.name}"${e.oldName ? `（原 "${e.oldName}"）` : ''}`)
    } else if (e.kind === '+') {
      lines.push(`+ [ref=${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}（新增）`)
    } else {
      lines.push(`- [ref=${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}（已消失）`)
    }
    if (e.path.length > 0) lines.push(`  位置：${e.path.join(' > ')}`)
  }
  lines.push('（其余元素与上次一致。看全量：domSnapshot({ full: true })）')
  return lines.join('\n')
}
