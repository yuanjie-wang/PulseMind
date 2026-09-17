// ── xlsx_edit service (PLAN-office-editing M5, T15) ──
// Same security sequence as docx-ops; the engine is the exceljs wrapper with
// precheck + read-back (L6). Backups share the docx backup directory (they
// are "office originals", the same restore story).

import { readFile, writeFile, rename } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { guardFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'
import { editXlsx, xlsxOutline, XlsxBatchError, scanXlsx } from '../xlsx/engine'
import { resolveWritablePath } from './file-ops'
import { backupOfficeOriginal } from './office-backup'
import type { XlsxEditOutcome } from '../../shared/office/ops'

const pReadFile = promisify(readFile)
const pWriteFile = promisify(writeFile)
const pRename = promisify(rename)

export interface XlsxEditResult extends Partial<XlsxEditOutcome> {
  success: boolean
  error?: string
  backup?: string
}

export async function svcEditXlsx(input: { filePath: string; ops: Array<Record<string, unknown>> }): Promise<XlsxEditResult> {
  try {
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)
    return await withPathLock(safePath, async (): Promise<XlsxEditResult> => {
      const original = await pReadFile(safePath)
      // Precheck before anything: .xls/encrypted/chart-laden workbooks refuse
      // with the actionable reason (L6).
      const scan = scanXlsx(original)
      if (!scan.ok) return { success: false, error: scan.reason }

      const outlineOnly = input.ops.length === 1 && input.ops[0].op === 'inspect' && !input.ops[0].sheet
      if (outlineOnly) {
        return { success: true, results: [{ index: 0, op: 'inspect', ok: true, detail: '' }], outline: await xlsxOutline(original), warnings: [] }
      }

      const { backup, warning } = await backupOfficeOriginal(safePath)
      let outcome: XlsxEditOutcome
      try {
        outcome = await editXlsx(original, input.ops)
      } catch (err) {
        if (err instanceof XlsxBatchError) {
          return { success: false, error: err.message, results: err.results, warnings: warning ? [warning] : [] }
        }
        return { success: false, error: err instanceof Error ? err.message : String(err), warnings: warning ? [warning] : [] }
      }
      const tmpPath = join(dirname(safePath), `.${basename(safePath)}.pm-tmp`)
      await pWriteFile(tmpPath, outcome.buffer)
      await pRename(tmpPath, safePath)
      return {
        ...outcome,
        success: true,
        warnings: warning ? [warning, ...outcome.warnings] : outcome.warnings,
        backup,
      }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
