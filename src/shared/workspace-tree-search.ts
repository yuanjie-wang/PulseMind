// ── Workspace tree filename search (PLAN-project-ide 刀二; extracted from
// WorkspaceTree.tsx 2026-10-31) ─────────────────────────────────────────────
//
// The tree's own name filter: a debounced query walks the workspace through
// the host listDir bridge and rebuilds a filtered tree. It lives here so
// vitest can drive the walk against a fake listDir without importing a
// component file — the two 「漏」 bugs of 2026-10-31 both lived in this walk:
//   1. a matched DIRECTORY whose subtree held no further matches was dropped
//      by the builder (a dir survived only when children.length > 0) —
//      searching a folder's own name showed nothing at all;
//   2. the walk had no skip list, so node_modules/.git burned the dir-walk
//      budget on any code workspace and every directory after them was never
//      scanned (the truncated flag said so, but the hits were still missing).

export interface TreeSearchEntry {
  name: string
  path: string
  isDir: boolean
}

/** A filtered-tree node carries the listing entry it came from — the tree's
 *  titleRender and hover actions read it (same shape as WorkspaceTree's
 *  WorkspaceNode minus rc-tree's DataNode bookkeeping). */
export interface TreeSearchNode {
  title: string
  key: string
  entry: TreeSearchEntry
  isLeaf?: true
  children?: TreeSearchNode[]
}

export interface TreeSearchResult {
  nodes: TreeSearchNode[]
  expanded: string[]
  truncated: boolean
}

/** Dependency/VCS/scratch trees: the walk budget is small on purpose, and
 *  these names are the bulk of any code workspace (node_modules alone
 *  routinely exceeds 100k entries). Skipped at every depth — the same stance
 *  as knowledge-queries' SKIP_DIRS, plus the .pulsemind scratch namespace. A
 *  hit inside them is unfindable by design (VS Code's default excludes behave
 *  the same); the budget stays spent on the user's own files. The tree itself
 *  still LISTS these directories — only the filename search declines to walk
 *  them. */
export const TREE_SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '.pulsemind'])

export const MAX_WALKED_DIRS = 400
export const MAX_MATCHES = 100

export type TreeSearchListDir = (dir: string) => Promise<{ entries: TreeSearchEntry[] } | null>

export async function walkTreeSearch(rootDir: string, query: string, listDir: TreeSearchListDir): Promise<TreeSearchResult> {
  const needle = query.toLowerCase()
  const byParent = new Map<string, TreeSearchEntry[]>()
  const matched = new Set<string>()
  let walked = 0
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (walked >= MAX_WALKED_DIRS) {
      truncated = true
      return
    }
    walked += 1
    const res = await listDir(dir)
    if (!res) return
    byParent.set(dir, res.entries)
    for (const entry of res.entries) {
      // The match cap is HONEST, not just a recursion stop: once the cap is
      // reached, later entries in this very directory stop being recorded too
      // (the truncation hint promises 「仅显示前 N 条」 — a list larger than
      // its own claim is the same 「漏」 family). Recursion stops with it, so
      // deeper directories are skipped wholesale.
      if (entry.name.toLowerCase().includes(needle) && matched.size < MAX_MATCHES) {
        matched.add(entry.path)
        if (matched.size >= MAX_MATCHES) truncated = true
      }
      if (entry.isDir && !truncated && !TREE_SEARCH_SKIP_DIRS.has(entry.name)) await walk(entry.path)
    }
  }
  await walk(rootDir)

  const expanded: string[] = []
  const build = (dir: string): TreeSearchNode[] => {
    const nodes: TreeSearchNode[] = []
    for (const entry of byParent.get(dir) ?? []) {
      if (entry.isDir) {
        const children = build(entry.path)
        if (children.length > 0) {
          expanded.push(entry.path)
          nodes.push({ title: entry.name, key: entry.path, entry, children })
        } else if (matched.has(entry.path)) {
          // The directory's OWN name matched but nothing inside did — it used
          // to vanish here entirely (leak #1 of 2026-10-31). Keep it as an
          // openable leaf. This branch also covers directories the walk never
          // entered (budget/skip): their name can still match.
          nodes.push({ title: entry.name, key: entry.path, entry, isLeaf: true })
        }
      } else if (matched.has(entry.path)) {
        nodes.push({ title: entry.name, key: entry.path, entry, isLeaf: true })
      }
    }
    return nodes
  }
  return { nodes: build(rootDir), expanded, truncated }
}
