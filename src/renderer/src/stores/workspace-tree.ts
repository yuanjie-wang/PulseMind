// ── 工作区 tree: expansion-cache logic (pure — vitest covers it directly) ──
// The tree's expansion state has to outlive the component (WorkbenchPane
// unmounts it on every tab switch), so it lives in workspaceTreeStore keyed by
// workspace dir. This file holds everything about that cache that can be
// decided without React: the recency cap, and what a deletion does to a cached
// key list.

/** Cached dirs kept by recency (insertion order); beyond this the oldest
 *  workspace's expansion state is dropped. */
export const MAX_WORKSPACE_DIRS = 10

/**
 * Copy of `keys` without `target` and without everything under it.
 * Deleting a folder must take its descendants out of the cache too — otherwise
 * the next mount would re-expand a path that no longer exists. Separator-aware:
 * keys are built by main's `path.join`, so a child is `target + '/'` on posix
 * and `target + '\\'` on Windows, and a sibling sharing a prefix (`/w/a` vs
 * `/w/ab`) must survive.
 */
export function dropSubtree(keys: readonly string[], target: string): string[] {
  return keys.filter((k) => k !== target && !k.startsWith(`${target}/`) && !k.startsWith(`${target}\\`))
}

/** Minimal shape the walk below needs — no antd/React import in a pure module.
 *  `key` includes `bigint` because that is `React.Key` since @types/react 18.3:
 *  antd's `DataNode` keys are typed `Key`, so `string | number` alone would
 *  reject every real tree node at the call site (`removeNode(prev.entries, …)`). */
export interface TreeNodeShape {
  key?: string | number | bigint
  children?: TreeNodeShape[]
}

/** Remove the node with `key` (and its subtree) from a loaded tree level,
 *  wherever it sits. Levels the deletion did not touch come back as the very
 *  same reference, so the tree's `setState` on an unrelated key is a no-op. */
export function removeNode<T extends TreeNodeShape>(nodes: T[], key: string): T[] {
  const kept = nodes.filter((node) => String(node.key) !== key)
  if (kept.length !== nodes.length) return kept
  let changed = false
  const next = nodes.map((node) => {
    if (!node.children) return node
    const children = removeNode(node.children as T[], key)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : nodes
}
