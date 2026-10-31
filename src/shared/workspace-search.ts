// ── Workspace content search line format (PLAN-project-ide 刀二) ────────────
//
// svcSearchWorkspace (main) shells the bundled rg with `--no-heading -n`, so
// every line it returns is `path:line:text`. The renderer's search panel parses
// them back into clickable rows; the parser lives here because the FORMAT is
// the contract between the two sides — and so vitest can pin it without
// importing a component file.

export interface WorkspaceSearchRow {
  path: string
  line: number
  text: string
}

/** `path:line:text` → row. Non-greedy up to the FIRST `:<digits>:` — Windows
 *  drive letters (`C:\…`) are skipped by the backtracking (`\a` is not
 *  `:<digits>:`). An empty match text (rg printed nothing after the second
 *  colon) still yields a valid row: the path/line are the clickable anchors. */
export function parseSearchLine(line: string): WorkspaceSearchRow | null {
  const m = line.match(/^(.*?):(\d+):(.*)$/)
  if (!m) return null
  const lineNo = Number(m[2])
  if (!Number.isFinite(lineNo) || lineNo <= 0) return null
  return { path: m[1], line: lineNo, text: m[3] }
}
