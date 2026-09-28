// ── office_inspect result formatting (2026-09-28) ──
// The service (main/services/office-inspect.ts) computes the structured
// inventory; THIS module decides what the model actually sees. For its whole
// first year the executor shipped only `result.summary` — one statistics line
// — so the details payload was computed and dropped, and every office read
// went inspect → learn nothing → read/python anyway. The renderer formats
// here (like the edit branch formats its outline) under one char budget, so
// the inventory stays a tool result, not a file dump, and the next-step
// envelope always lands as the TRUE last bytes.

import type { OfficeInspectResult } from '../../../shared/office/ops'

/** Char budget of the formatted inventory. Worst case is ~1 token per char
 *  (CJK — estimateTextTokens), so this must stay inside the token override
 *  below: the engine's own head+tail guardrail then never fires on an inspect
 *  result, and the envelope is not spliced mid-truncation. */
export const INSPECT_RESULT_CHAR_BUDGET = 6000
/** Token ceiling passed to addToolResult for inspect results (see above). */
export const INSPECT_RESULT_TOKEN_BUDGET = 8000

const NEXT_STEP = '下一步：读全文或继续翻页 → read（自动转 markdown）；要编辑 → 对照上面的清单调 docx_edit / xlsx_edit / pptx_edit。'

/** Escape one cell for a markdown table row (pipes and line breaks break it). */
function escCell(s: string): string {
  return s
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** First row becomes the header row — data tables usually have one, and a
 *  markdown table needs some header line to be a table at all. */
function markdownTable(rows: string[][]): string[] {
  const [header, ...body] = rows
  if (!header) return []
  const lines = [`| ${header.map(escCell).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of body) lines.push(`| ${row.map(escCell).join(' | ')} |`)
  return lines
}

export function formatInspectResult(result: OfficeInspectResult): string {
  const parts: string[] = [result.summary]
  let used = result.summary.length + 1
  let truncated = false
  /** Line-level budget: on the first line that does not fit, set the flag and
   *  refuse everything after — callers break their loops on the false return. */
  const push = (line: string): boolean => {
    if (truncated) return false
    if (used + line.length + 1 > INSPECT_RESULT_CHAR_BUDGET) {
      truncated = true
      return false
    }
    parts.push(line)
    used += line.length + 1
    return true
  }

  const d = result.details

  if (result.format === 'docx' && d.paragraphs?.length) {
    if (push('大纲（[段落] 样式: 长度 — 预览）:')) {
      // Same 120-line display cap the edit branch's outline rendering uses.
      const shown = d.paragraphs.slice(0, 120)
      for (const p of shown) {
        if (!push(`[${p.index}] ${p.style ?? '-'}: ${p.textLength}字 — ${p.text || '(空段落)'}`)) break
      }
      if (!truncated && d.paragraphs.length > shown.length) {
        push(`…（共 ${d.paragraphs.length} 段，已列前 ${shown.length} 段）`)
      }
    }
    if (d.textBudget !== undefined) push(`文本预算: ${d.textBudget} 字符（替换文案的上限，超出会溢出）`)
    if (d.images) push(`图片: ${d.images} 张`)
  } else if (result.format === 'xlsx' && d.sheets?.length) {
    if (push('工作表:')) {
      for (const s of d.sheets) {
        if (!push(`- ${s.name}: ${s.usedRange}（${s.rowCount} 行 × ${s.columnCount} 列）`)) break
        if (s.head?.length) {
          if (!push(`  预览前 ${s.head.length} 行 × 前 ${s.head[0].length} 列:`)) break
          let broke = false
          for (const line of markdownTable(s.head)) {
            if (!push(`  ${line}`)) {
              broke = true
              break
            }
          }
          if (broke) break
        }
      }
    }
    if (d.formulas?.length) {
      const shown = d.formulas.slice(0, 15)
      if (push('公式:')) {
        for (const f of shown) {
          if (!push(`- ${f}`)) break
        }
        if (!truncated && d.formulas.length > shown.length) {
          push(`…（其余 ${d.formulas.length - shown.length} 条公式略）`)
        }
      }
    }
    if (d.charts) push(`图表: ${d.charts} 个（含图表的工作簿，部分 xlsx_edit 算子会被拒绝）`)
  } else if (result.format === 'pptx' && d.slides?.length) {
    if (push('幻灯片:')) {
      for (const s of d.slides) {
        if (!push(`— 第 ${s.index} 页（${s.shapeCount} 形状）: ${s.text || '(无文本)'}`)) break
      }
    }
    if (d.images) push(`图片: ${d.images} 张`)
  }

  if (truncated) parts.push('…（清单超长被截断——完整内容用 read 读取）')
  parts.push(NEXT_STEP)
  return parts.join('\n')
}
