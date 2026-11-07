// ── office_search result formatting (2026-10-12) ──
// Same split as office-read-format: the service (main/services/office-search)
// computes the coordinate-anchored hits; THIS module decides what the model
// sees. Hits are coordinate-anchored so every envelope teaches the follow-up
// read by those coordinates — the search is the locator, office_read the
// reader.

import type { OfficeSearchResult } from '../../../shared/office/ops'

export const OFFICE_SEARCH_CHAR_BUDGET = 24_000

/** Snippets are display lines: collapse any whitespace run (a pptx shape's
 *  paragraphs are joined with \n before matching) so one hit stays one line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function formatOfficeSearchResult(result: OfficeSearchResult): string {
  const parts: string[] = [result.summary]
  let used = result.summary.length + 1
  let truncated = false
  const push = (line: string): boolean => {
    if (truncated) return false
    if (used + line.length + 1 > OFFICE_SEARCH_CHAR_BUDGET) {
      truncated = true
      return false
    }
    parts.push(line)
    used += line.length + 1
    return true
  }

  const d = result.details
  const hits = d.hits ?? []

  if (hits.length === 0) {
    parts.push('无命中——换更短的关键词、开 regex（query 按正则解释），或用 office_read/office_inspect 确认结构后再找。')
    // 预算/格数帽在首个命中前中止时，scanNote 是「这只是部分扫描」的唯一
    // 信号——零命中分支提前返回也要带上，否则部分覆盖被渲染成诚实无命中。
    if (d.scanNote) parts.push(d.scanNote)
    return parts.join('\n')
  }

  if (result.format === 'docx') {
    if (push('命中段落（[段落] 样式: 摘录）:')) {
      for (const h of hits) {
        if (!push(`[${h.index}] ${h.style ?? '-'}: ${oneLine(h.snippet)}`)) break
      }
    }
    // [段落号] is the 0-based EDIT coordinate; office_read's offset is
    // 1-based — the envelope spells the +1 out.
    parts.push(`下一步：精读 → office_read offset=[段落号]+1 limit=40；编辑 → 对照段落索引调 office_edit。`)
  } else if (result.format === 'xlsx') {
    if (push('命中单元格（工作表!地址: 摘录 ｜ 所在行前几格）:')) {
      for (const h of hits) {
        const row = (h.rowPreview ?? []).join(' | ')
        if (!push(`- ${h.sheet}!${h.address}: ${oneLine(h.snippet)}${row ? ` ｜ 行: ${oneLine(row)}` : ''}`)) break
      }
    }
    // The row number already lives in every hit's address (C12 → 12) — the
    // envelope splices the FIRST hit's real row in so the model copies it
    // instead of converting itself (docx envelope's `[段落号]+1` precedent).
    // Cross-sheet hits each carry their own sheet!address in the list above;
    // the offset named here is the first hit's, said so. Hit fields are all
    // optional in the shared shape — every splice falls back to the honest
    // placeholder. (review_20261013 低4)
    const first = hits[0]
    const firstRow = Number(first?.address?.match(/(\d+)$/)?.[1] ?? NaN)
    const firstWhere = first?.sheet && first?.address ? ` ${first.sheet}!${first.address}` : ''
    parts.push(
      `下一步：精读首条命中${firstWhere} → office_read sheet="${first?.sheet ?? '<工作表>'}" offset=${Number.isFinite(firstRow) ? firstRow : '<行号>'} limit=5；跨工作表命中按各行地址取行号；编辑 → office_edit 的 xlsx 算子（单元格地址 = 行号 + 列字母）。`,
    )
  } else if (result.format === 'pptx') {
    if (push('命中形状（页 · [shapeId] 名称: 摘录）:')) {
      for (const h of hits) {
        if (!push(`- 第 ${h.slide} 页 [${h.shapeId}] ${h.name}: ${oneLine(h.snippet)}`)) break
      }
    }
    parts.push(`下一步：读整页 → office_read slide=N；编辑 → 对照 shape id 调 office_edit。`)
  }

  if (d.scanNote) parts.push(d.scanNote)

  return parts.join('\n')
}
