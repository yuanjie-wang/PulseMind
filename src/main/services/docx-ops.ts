// ── docx_edit service (PLAN-office-editing M3, T8) ──
// The same security sequence as every other write: sandbox guard → writable
// path → per-path FIFO lock → first-edit backup (L10) → engine (in memory,
// gates on) → atomic tmp+rename. The engine already refuses .doc/encrypted/
// wrong-encoding blobs (openDocxPackage).

import { readFile, writeFile, rename } from 'node:fs'
import { extname } from 'node:path'
import { DECK_IMAGE_EXTS } from '../../shared/deck/spec'
import { basename, join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { guardFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'
import { editDocx, openDocxPackage, OpBatchError, type EditDocxResult } from '../docx/package'
import type { DocxToolOp } from '../../shared/office/ops'
import { outlineOf, buildDocumentModel } from '../docx/model'
import { resolveWritablePath } from './file-ops'
import { backupOfficeOriginal } from './office-backup'
import { snapshotToWorkspace, generateOfficeDiff, buildChangeSummary } from './office-snapshot'
import { currentSessionSandbox } from '../sandbox/session-context'

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
  diff?: string
  changeSummary?: string
}

export async function svcEditDocx(input: { filePath: string; ops: DocxToolOp[]; workspaceDir?: string }): Promise<DocxEditResult> {
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
          const model = buildDocumentModel(docXml)
          return { success: true, results: [{ index: 0, op: 'outline', ok: true, detail: '' }], outline: outlineOf(model), tables: model.tables.map((t) => ({ index: t.index, rows: t.rows.length, cols: t.rows[0]?.cells.length ?? 0 })) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const { backup, warning } = await backupOfficeOriginal(safePath)
      // P2.5: snapshot to conversation workspace .versions/. A renderer-driven
      // session (the desktop chat) has no AsyncLocalStorage context, so the
      // caller's workspaceDir rides the IPC payload as the fallback (M7) —
      // without it the snapshot silently never happened on the main battlefield.
      const sandbox = currentSessionSandbox()
      await snapshotToWorkspace(safePath, sandbox?.workspaceDir ?? input.workspaceDir)
      let outcome: EditDocxResult
      try {
        outcome = editDocx(original, input.ops, {
          // M3 (PLAN-office-expressiveness): op 只带工作区路径，服务层读
          // 字节（IPC 载荷保持 JSON 安全）——扩展名白名单与 deck 同源。
          resolveImageBytes: async (path) => {
            const ext = extname(path).toLowerCase().replace('.', '')
            if (!(DECK_IMAGE_EXTS as readonly string[]).includes('.' + ext)) return null
            const imgGuard = await guardFsTarget(path, 'read')
            if (!imgGuard.ok) return null
            try {
              return { ext, bytes: await pReadFile(await resolveWritablePath(path)) }
            } catch {
              return null
            }
          },
        })
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
      // P2.5: generate diff and change summary for the tool result
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
        tables: outcome.tables,
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
