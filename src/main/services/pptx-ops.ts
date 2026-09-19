// ── pptx_edit service (PLAN-pptx-editing, svcEditDocx's slide twin) ── The
//  same security sequence: sandbox guard → writable path → per-path FIFO lock
//  → first-edit backup → workspace snapshot → engine (in memory, gates on) →
//  atomic tmp+rename. The engine already refuses .ppt/encrypted/wrong-
//  encoding blobs (openPptxPackage).

import { readFile, writeFile, rename } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { guardFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'
import { editPptx, openPptxPackage, OpBatchError, type EditPptxResult } from '../pptx/package'
import type { PptxToolOp } from '../../shared/office/ops'
import { buildSlideModel, slidePartNames, outlineOf } from '../pptx/model'
import { resolveWritablePath } from './file-ops'
import { backupOfficeOriginal } from './office-backup'
import { snapshotToWorkspace, generateOfficeDiff, buildChangeSummary } from './office-snapshot'
import { currentSessionSandbox } from '../sandbox/session-context'

const pReadFile = promisify(readFile)
const pWriteFile = promisify(writeFile)
const pRename = promisify(rename)

export interface PptxEditResult {
  success: boolean
  error?: string
  results?: Array<{ index: number; op: string; ok: boolean; detail: string }>
  outline?: Array<{ slide: number; shapes: Array<{ shapeId: string; name: string; phType?: string; text: string }> }>
  warnings?: string[]
  backup?: string
  diff?: string
  changeSummary?: string
}

export async function svcEditPptx(input: { filePath: string; ops: PptxToolOp[]; workspaceDir?: string }): Promise<PptxEditResult> {
  try {
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)
    return await withPathLock(safePath, async (): Promise<PptxEditResult> => {
      const original = await pReadFile(safePath)
      // Outline-only calls work on the CURRENT file (no write, no backup).
      const outlineOnly = input.ops.length === 1 && input.ops[0].op === 'outline'
      if (outlineOnly) {
        try {
          const zip = openPptxPackage(original)
          const names = slidePartNames(
            (zip.readFile('ppt/presentation.xml') as Buffer).toString('utf8'),
            (zip.readFile('ppt/_rels/presentation.xml.rels') as Buffer).toString('utf8')
          )
          const outline = names.map((name, i) =>
            outlineOf(buildSlideModel((zip.readFile(name) as Buffer).toString('utf8')), i + 1)
          )
          return { success: true, results: [{ index: 0, op: 'outline', ok: true, detail: `${names.length} 页` }], outline }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const { backup, warning } = await backupOfficeOriginal(safePath)
      const sandbox = currentSessionSandbox()
      await snapshotToWorkspace(safePath, sandbox?.workspaceDir ?? input.workspaceDir)
      let outcome: EditPptxResult
      try {
        outcome = editPptx(original, input.ops)
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
      let diff: string | undefined
      let changeSummary: string | undefined
      if (backup) {
        diff = await generateOfficeDiff(backup, safePath)
        changeSummary = buildChangeSummary(outcome.results)
      }
      return {
        success: true,
        results: outcome.results,
        outline: outcome.outline,
        warnings: warning ? [warning, ...outcome.warnings] : outcome.warnings,
        backup,
        diff,
        changeSummary,
      }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
