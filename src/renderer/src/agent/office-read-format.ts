// ── office_read result formatting (PLAN-office-read) ──
// The service (main/services/office-read.ts) computes the paged structure
// reads; THIS module decides what the model sees — same split as
// office-inspect-format. One char budget for every format, so the result
// stays a tool result, not a file dump, and the next-step envelope (the
// offset/slide/sheet that continues the read) is always the TRUE last bytes.

import type { OfficeReadResult } from '../../../shared/office/ops'

/** Char budget of the formatted read. Worst case ~1 token per char (CJK) —
 *  stays inside the MAX_READ_RESULT_TOKENS override the executor passes. */
export const OFFICE_READ_CHAR_BUDGET = 24_000

/** Escape one cell for a markdown table row (pipes and line breaks break it). */
function escCell(s: string): string {
  return s
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

export function formatOfficeReadResult(result: OfficeReadResult): string {
  const parts: string[] = [result.summary]
  let used = result.summary.length + 1
  let truncated = false
  /** Line-level budget: on the first line that does not fit, set the flag and
   *  refuse everything after — callers break their loops on the false return. */
  const push = (line: string): boolean => {
    if (truncated) return false
    if (used + line.length + 1 > OFFICE_READ_CHAR_BUDGET) {
      truncated = true
      return false
    }
    parts.push(line)
    used += line.length + 1
    return true
  }

  const d = result.details

  if (result.format === 'docx' && d.headings) {
    if (push('标题（[段落] 级别: 文本）:')) {
      for (const h of d.headings) {
        if (!push(`[${h.index}] ${h.level ?? '?'} ${h.style ?? '-'}: ${h.text}`)) break
      }
    }
    // [段落号] is the 0-based EDIT coordinate (office_edit consumes it
    // verbatim); office_read's offset is 1-based — the envelope spells the
    // +1 out instead of letting the model guess.
    parts.push(`下一步：按 [段落号] 精读章节 → offset=[段落号]+1（读到下一同级标题前）；编辑 → 对照段落索引调 office_edit。`)
  } else if (result.format === 'docx' && d.paragraphs) {
    if (d.paragraphs.length > 0 && push('段落全文（[段落] 样式: 文本）:')) {
      for (const p of d.paragraphs) {
        if (!push(`[${p.index}] ${p.style ?? '-'}: ${p.text || '(空段落)'}`)) break
      }
    }
    if (d.tables?.length && push('表格（单元格文本，行内以 | 分列）:')) {
      for (const t of d.tables) {
        if (!push(`表 ${t.index}：${t.rows} 行 × ${t.cols} 列`)) break
        if (!t.cells) continue
        let broke = false
        for (let r = 0; r < t.cells.length; r++) {
          if (!push(`  R${r + 1}: ${t.cells[r].map(escCell).join(' | ')}`)) {
            broke = true
            break
          }
        }
        if (broke) break
      }
    }
    if (truncated) {
      parts.push(`…（超出预算被截断——用更小的 limit 或 range 重读）`)
      parts.push(`下一步：重读 → offset=${d.paragraphs[0]?.index ?? 0} limit=<更小>；编辑 → 对照段落索引调 office_edit。`)
    } else if (d.nextOffset) {
      parts.push(`下一步：继续读 → offset=${d.nextOffset}；编辑 → 对照段落索引调 office_edit（表格行用 表/行 号）。`)
    } else {
      parts.push(`下一步：已到文档末尾（共 ${d.paragraphCount ?? 0} 段）；编辑 → 对照段落索引调 office_edit。`)
    }
  } else if (result.format === 'xlsx' && (d.cells || d.sheets)) {
    if (d.sheets && !d.cells) {
      if (push('工作表:')) {
        for (const s of d.sheets) {
          if (!push(`- ${s.name}: ${s.rowCount} 行 × ${s.columnCount} 列`)) break
        }
      }
      parts.push(`下一步：读值 → sheet="<名称>"（可加 range="A1:J50" 或 offset/limit 翻行）。`)
    } else if (d.cells) {
      // Column-letter header so every cell carries its own set_cell address.
      const cols = d.cells[0]?.length ?? 0
      const startCol = 1
      const letter = (n: number): string => {
        let s = ''
        while (n > 0) {
          s = String.fromCharCode(65 + ((n - 1) % 26)) + s
          n = Math.floor((n - 1) / 26)
        }
        return s
      }
      if (push(`| 行 | ${Array.from({ length: cols }, (_, i) => letter(startCol + i)).join(' | ')} |`)) {
        push(`| --- | ${Array.from({ length: cols }, () => '---').join(' | ')} |`)
        for (let r = 0; r < d.cells.length; r++) {
          // Absolute row number — the window offset is NOT the address, and a
          // set_cell aimed at the display number would edit a different cell.
          if (!push(`| ${(d.startRow ?? 1) + r} | ${d.cells[r].map(escCell).join(' | ')} |`)) break
        }
      }
      if (truncated) {
        parts.push(`…（超出预算被截断——用更小的 limit 或 range 重读）`)
        parts.push(`下一步：重读 → sheet="${d.sheet}" offset=${d.startRow ?? 1} limit=<更小>；编辑 → office_edit 的 xlsx 算子；单元格地址 = 行号 + 列字母。`)
      } else if (d.nextOffset) {
        parts.push(
          `下一步：继续读 → sheet="${d.sheet}" offset=${d.nextOffset}；编辑 → office_edit 的 xlsx 算子；单元格地址 = 行号 + 列字母（公式显示为 =式 → 结果，set_cell 重写表达式）。`,
        )
      } else {
        parts.push(`下一步：已到「${d.sheet}」末尾；编辑 → office_edit 的 xlsx 算子；单元格地址 = 行号 + 列字母。`)
      }
    }
  } else if (result.format === 'pptx' && d.slideTitles) {
    if (push('页标题（slide: 标题）:')) {
      for (const s of d.slideTitles) {
        if (!push(`第 ${s.index} 页: ${s.title || '(无标题)'}`)) break
      }
    }
    parts.push(`下一步：读整页 → slide=N；编辑 → 对照 shape id 调 office_edit。`)
  } else if (result.format === 'pptx' && d.slides) {
    for (const s of d.slides) {
      if (!push(`— 第 ${s.index} 页（${s.shapes.length} 形状）:`)) break
      let broke = false
      for (const shape of s.shapes) {
        const ph = shape.phType ? `(${shape.phType})` : ''
        const paragraphs = shape.text.length > 0 ? shape.text.split('\n') : ['(无文本)']
        if (!push(`  [${shape.shapeId}]${ph} ${shape.name}: ${paragraphs[0] || '(无文本)'}`)) {
          broke = true
          break
        }
        for (const extra of paragraphs.slice(1)) {
          if (!push(`    ${extra}`)) {
            broke = true
            break
          }
        }
        if (broke) break
      }
      if (broke) break
    }
    if (truncated) {
      parts.push(`…（超出预算被截断——用 slide=N 逐页读）`)
      parts.push(`下一步：读单页 → slide=N；编辑 → 对照 shape id 调 office_edit。`)
    } else {
      parts.push(`下一步：编辑 → 对照 shape id 调 office_edit 的 pptx 算子（set_shape_text 整形状重写，replace_text 跨形状查替换）。`)
    }
  }

  return parts.join('\n')
}
