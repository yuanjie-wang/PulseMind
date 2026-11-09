/** 单笔运行: 停止按钮 + the configured 单次超时 (user 2026-09-26:
 *  「日常任务需要停止按钮」「设置批量参数后，再使用单笔运行，无法享受到超时时间等配置」).
 *
 * vitest here is node-env: the handler cannot be registered and the renderer
 * cannot be mounted, so the surface is asserted against the sources the way
 * tests/routine-batch-wiring.test.ts does it — a channel declared but never
 * handled answers methodNotFound, a bridge method without a preload entry is
 * undefined at the call site, and a runner that never registers its handle is
 * a stop button that silently does nothing. The BEHAVIOUR (handle → engine →
 * 用户停止 settlement, and the ceiling a single run actually schedules) rides
 * scripts/probe-routine-batch.mjs section 15.
 *
 * Non-vacuity: every scan asserts an exact or minimum marker count, so a
 * renamed member or a broken regex fails loudly instead of matching nothing. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

describe('single-run stop: the five-layer surface', () => {
  it('declares the channel beside routine:run', () => {
    const src = source('src/shared/ipc-channels.ts')
    expect(src).toContain("ROUTINE_RUN_STOP: 'routine:run-stop'")
  })

  it('handles the channel in the routine handler', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src).toContain('ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_STOP')
    // The handler must route into the runner's own stop — stopping the session
    // any other way leaves the row 'running' until its timeout fires.
    expect(src).toContain('routineRunner.stop(runId)')
  })

  it('exposes it on the preload bridge', () => {
    const src = source('src/preload/index.ts')
    expect(src).toMatch(/routineRunStop:.*ROUTINE_RUN_STOP/s)
  })

  it('types it in the shared bridge contract', () => {
    const src = source('src/shared/types/electron-bridge.ts')
    expect(src).toMatch(/routineRunStop: \(runId: string\) => Promise<void>/)
    // Batch rows keep their own transport — the two must not collapse into one.
    expect(src).toContain('routineBatchStop:')
  })
})

describe('single-run stop: the runner registry', () => {
  const src = source('src/main/routine/routine-runner.ts')

  it('registers the handle executeUnattended returns', () => {
    // Without the set, stop() always throws 「该运行已不在进行中」 — the exact
    // shape a button wired to nothing produces.
    expect(src).toMatch(/activeSingleRuns\.set\(run\.id, executeUnattended\(/)
  })

  it('exposes stop() that interrupts through that handle', () => {
    expect(src).toMatch(/stop\(runId: string\): void/)
    expect(src).toContain('const handle = activeSingleRuns.get(runId)')
    expect(src).toContain('handle.stop()')
    // Refuse rather than no-op: a stale 运行中 row must say why.
    expect(src).toContain('该运行已不在进行中')
  })

  it('leaves the registry on SETTLEMENT only — never inside stop()', () => {
    // Exactly one delete, on the run's own onSettled — which now ALSO calls
    // the scheduler's slot-release hook (event-driven release), still strictly
    // at settlement. Deleting on stop too would empty the registry during the
    // beat it takes stopExecution to park the engine, so the row still reads
    // 运行中 while a second click gets the misleading 「该运行已不在进行中」
    // toast — a harmless repeat is the right answer there (the handle's
    // settled/stopRequested guard no-ops it).
    expect(src).toMatch(/onSettled: \(\) => \{ activeSingleRuns\.delete\(run\.id\); onSettled\?\.\(\) \}/)
    expect(src.match(/activeSingleRuns\.delete\(/g)?.length).toBe(1)
    // And stop() itself only interrupts — no registry surgery.
    const stopBody = src.slice(src.indexOf('stop(runId: string): void'))
    expect(stopBody.slice(0, stopBody.indexOf('\n  },'))).not.toContain('activeSingleRuns.delete')
  })

  it('does NOT register batch rows — the batch pool owns those handles', () => {
    expect(source('src/main/routine/batch-runner.ts')).not.toContain('activeSingleRuns')
  })
})

describe('the renderer routes each shape to its own transport', () => {
  const stopRun = source('src/renderer/src/components/routine/stop-run.ts')

  it('one dispatch keyed on run.batch (batch pool vs single handle)', () => {
    expect(stopRun).toContain('window.electronAPI.routineBatchStop(run.id)')
    expect(stopRun).toContain('window.electronAPI.routineRunStop(run.id)')
    expect(stopRun).toMatch(/if \(run\.batch\)/)
    // One copy of the confirm text, or the two surfaces drift apart.
    expect(stopRun).toContain('export function stopRunConfirm')
  })

  it('both stop surfaces call it (workspace rows/header, unified sidebar)', () => {
    for (const file of [
      'src/renderer/src/components/routine/RoutineWorkspace.tsx',
      // P3 任务中心：落地页停止面收进 UnifiedRunsSidebar（两类 run 共用）。
      'src/renderer/src/components/routine/UnifiedRunsSidebar.tsx',
    ]) {
      const src = source(file)
      expect(src).toContain("from './stop-run'")
      expect(src).toContain('stopRoutineRun(')
      expect(src).toContain('stopRunConfirm(')
    }
  })

  it('a stop button is only offered while the run is actually running', () => {
    const workspace = source('src/renderer/src/components/routine/RoutineWorkspace.tsx')
    expect(workspace.match(/run\.status === 'running' &&/g)?.length).toBeGreaterThanOrEqual(1)
    const sidebar = source('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')
    expect(sidebar).toContain('row.running &&')
  })
})

describe('the configured 单次超时 reaches a single run', () => {
  it('routine-runner resolves its ceiling through the shared chain', () => {
    const src = source('src/main/routine/routine-runner.ts')
    expect(src).toContain('effectiveTimeoutMinutes(routine.batch)')
    // …and passes it into the primitive — a resolved value that never reaches
    // executeUnattended is the bug all over again.
    expect(src).toMatch(/executeUnattended\(\{[\s\S]{0,400}timeoutMs,/)
  })

  it('batch-runner resolves the same chain (one config, two shapes of run)', () => {
    const src = source('src/main/routine/batch-runner.ts')
    expect(src.match(/effectiveTimeoutMinutes\(routine\.batch\)/g)?.length).toBe(2)
    // The old inline tail is gone — two copies of the chain is how they drift.
    expect(src).not.toContain('?? DEFAULT_BATCH_TIMEOUT_MINUTES')
  })

  it('the editor says the value bounds a single run too', () => {
    const src = source('src/renderer/src/components/routine/RoutineForm.tsx')
    expect(src).toContain('单笔运行')
  })

  it('the run dialog shows the ceiling it will run under', () => {
    expect(source('src/renderer/src/components/routine/RoutineRunModal.tsx')).toContain('runModalTimeout')
    expect(source('src/renderer/src/i18n/locales/zh.ts')).toContain('runModalTimeout:')
    expect(source('src/renderer/src/i18n/locales/en.ts')).toContain('runModalTimeout:')
  })
})
