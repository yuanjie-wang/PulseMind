// ── domSnapshot over Playwright's AI snapshot engine (PLAN-browser-snapshot-ai) ──
// ONE observation = ONE `ariaSnapshotJSON({ mode: 'ai' })` pull. Playwright
// walks the ARIA tree itself — including iframes (the old self-written pass was
// blind to them) — and assigns every node a persistent `ref: eN`, which is the
// addressing scheme: `aria-ref=eN` resolves through the host's locator engine,
// and nothing is ever written into the page realm.
//
// The tree is rendered (snapshot-render.ts) and, when the tab has a previous
// snapshot of the SAME document (sameDocumentUrl — a hash-route module switch
// does not end the diff), diffed (snapshot-diff.ts) — the diff rides by
// default, `{ full: true }` escapes. Trimming applies to the render; the FULL
// untrimmed tree is what the caller stores for the next diff, so a trimmed
// name never makes two snapshots disagree.

import type { Page } from 'playwright-core'
import { renderAriaTree, type AriaNode } from '../../shared/browser-client/snapshot-render'
import { diffTrees, renderDiff } from '../../shared/browser-client/snapshot-diff'

export type { AriaNode }

/** What the service stores per tab for the next diff (BrowserService's
 *  ServiceTab.lastSnapshot). Dropped naturally when the tab entry dies. */
export interface StoredSnapshot {
  url: string
  tree: AriaNode[]
}

/** Pull the AI-mode JSON tree once. The single data source for both the full
 *  render and the diff — the formats can never fork. */
export async function pullAriaTree(page: Page): Promise<AriaNode[]> {
  const tree = (await page.locator('html').ariaSnapshotJSON({ mode: 'ai' })) as AriaNode[]
  return Array.isArray(tree) ? tree : []
}

/** Two URLs name the SAME document for diff purposes when they differ only in
 *  the fragment. A hash router rewrites `#write` → `#contacts` on every module
 *  switch without reloading, so strict equality reset the diff each time: the
 *  model then paid for a full render (measured: 「879 处变化」) where a dozen-line
 *  diff would have named the real change — and lost the numbering-persistence
 *  header while at it. Query strings still count as a new document. */
export function sameDocumentUrl(a: string, b: string): boolean {
  return stripFragment(a) === stripFragment(b)
}

function stripFragment(url: string): string {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

/** One observation: full render by default, diff when a previous snapshot of
 *  the same document exists and `full` is not forced. Returns the text for the
 *  model AND the tree for the caller to store. */
export async function takeDomSnapshot(
  page: Page,
  prev?: StoredSnapshot | null,
  opts?: { full?: boolean },
): Promise<{ text: string; tree: AriaNode[] }> {
  const tree = await pullAriaTree(page)
  const url = page.url()

  const sameUrl = prev && sameDocumentUrl(prev.url, url)
  if (!opts?.full && sameUrl && prev) {
    const diff = diffTrees(prev.tree, tree)
    return { text: renderDiff(diff), tree }
  }

  const header = prev && sameUrl ? '── 页面全量（快照编号持久：旧编号仍指向未变化的元素）──\n' : ''
  return { text: header + renderAriaTree(tree), tree }
}
