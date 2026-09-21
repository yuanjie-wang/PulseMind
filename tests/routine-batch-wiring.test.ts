/** Batch IPC wiring (PLAN-routine-batch M4).
 *
 * vitest here is node-env: the handler module cannot be registered and the
 * renderer cannot be mounted, so the three-layer surface (channels → handler →
 * preload → bridge types) is asserted against the sources the way
 * tests/pending-approval.test.ts does. Each layer must carry ALL FOUR batch
 * members — a channel declared but never handled answers methodNotFound to
 * the user, which is exactly the class of bug this scan exists for.
 *
 * Non-vacuity: every scan asserts a minimum marker count, so a broken regex
 * or a renamed set of members fails loudly instead of matching nothing. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

const MEMBERS = ['ROUTINE_BATCH_RUN', 'ROUTINE_BATCH_STOP', 'ROUTINE_BATCH_ITEMS', 'ROUTINE_CSV_PREVIEW'] as const
const MIN = MEMBERS.length

describe('routine batch IPC wiring', () => {
  it('declares all four batch channels', () => {
    const src = source('src/shared/ipc-channels.ts')
    expect(src.match(/ROUTINE_(BATCH_RUN|BATCH_STOP|BATCH_ITEMS|CSV_PREVIEW):/g)?.length).toBeGreaterThanOrEqual(MIN)
  })

  it('handles all four channels in the routine handler', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src.match(/ipcMain\.handle\(IPC_CHANNELS\.ROUTINE_(BATCH_RUN|BATCH_STOP|BATCH_ITEMS|CSV_PREVIEW)/g)?.length).toBe(MIN)
  })

  it('exposes all four methods on the preload bridge', () => {
    const src = source('src/preload/index.ts')
    expect(src.match(/routine(BatchRun|BatchStop|BatchItems|CsvPreview):/g)?.length).toBe(MIN)
  })

  it('types all four methods in the shared bridge contract', () => {
    const src = source('src/shared/types/electron-bridge.ts')
    expect(src.match(/routine(BatchRun|BatchStop|BatchItems|CsvPreview):/g)?.length).toBe(MIN)
  })

  it('the preview result type lives in shared (renderer cannot import main)', () => {
    const src = source('src/shared/types/electron-bridge.ts')
    expect(src).toContain("from '../routine/batch'")
  })

  it('normalizeInput carries the batch config through the save door', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    // Both halves are load-bearing: the normalizer (which validates the shape)
    // and its wiring into the payload (without it a saved batch is dropped).
    expect(src).toContain('function normalizeBatchConfig')
    expect(src).toContain('batch: normalizeBatchConfig(input.batch)')
  })

  it('the batch start handler refuses a routine with no batch config', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src).toContain('没有配置批量数据文件')
  })
})
