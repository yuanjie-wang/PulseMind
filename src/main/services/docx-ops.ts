// ── docx_edit service (PLAN-office-editing M3, T8) ──
// The same security sequence as every other write: sandbox guard → writable
// path → per-path FIFO lock → first-edit backup (L10) → engine (in memory,
// gates on) → atomic tmp+rename. The engine already refuses .doc/encrypted/
// wrong-encoding blobs (openDocxPackage).

import { readFile, writeFile, rename } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { guardFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'
import { editDocx, openDocxPackage, OpBatchError, type EditDocxResult } from '../docx/package'
import type { DocxToolOp } from '../../shared/office/ops'
import { outlineOf, buildDocumentModel } from '../docx/model'
import { resolveWritablePath } from './file-ops'
import { backupOfficeOriginal } from './office-backup'

const pReadFile = promisify(readFile)
const pWriteFile = promisify(writeFile)
const pRename = promisify(rename)

export interface DocxEditResult {
  success: boolean
  error?: string
  results?: Array<{ index: number; op: string; ok: boolean; detail: string }>
  outline?: Array<{ index: number; style: string | null; text: string }>
  warnings?: string[]
  backup?: string
}

export async function svcEditDocx(input: { filePath: string; ops: DocxToolOp[] }): Promise<DocxEditResult> {
  try {
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)
    return await withPathLock(safePath, async (): Promise<DocxEditResult> => {
      const original = await pReadFile(safePath)
      // Outline-only calls work on the CURRENT file (no write, no backup).
      const outlineOnly = input.ops.length === 1 && input.ops[0].op === 'outline'
      if (outlineOnly) {
        try {
          const zip = openDocxPackage(original)
          const docXml = (zip.readFile('word/document.xml') as Buffer).toString('utf8')
          return { success: true, results: [{ index: 0, op: 'outline', ok: true, detail: '' }], outline: outlineOf(buildDocumentModel(docXml)) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const { backup, warning } = await backupOfficeOriginal(safePath)
      let outcome: EditDocxResult
      try {
        outcome = editDocx(original, input.ops)
      } catch (err) {
        if (err instanceof OpBatchError) {
          return { success: false, error: err.message, results: err.results, warnings: warning ? [warning] : [] }
        }
        return { success: false, error: err instanceof Error ? err.message : String(err), warnings: warning ? [warning] : [] }
      }
      // Atomic replace: write tmp sibling then rename over the target.
      const tmpPath = join(dirname(safePath), `.${basename(safePath)}.pm-tmp`)
      await pWriteFile(tmpPath, outcome.buffer)
      await pRename(tmpPath, safePath)
      return {
        success: true,
        results: outcome.results,
        outline: outcome.outline,
        warnings: warning ? [warning, ...outcome.warnings] : outcome.warnings,
        backup,
      }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
