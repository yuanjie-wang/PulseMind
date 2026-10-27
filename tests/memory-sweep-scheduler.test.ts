import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  judgeSweepCandidate,
  sweepIntervalMs,
  DEFAULT_MEMORY_EXTRACT_INTERVAL_HOURS,
  SWEEP_ACTIVE_WINDOW_MS,
} from '../src/shared/memory-sweep'

/** 定时清扫调度器（PLAN-memory-wiki M2c，用户裁定 2026-10-25：主时机 = 定时，
 *  默认 6h 可设 0=仅手动；afterSession/启动回填退役）。资格矩阵走真判定函数，
 *  接线走 wiring 扫描（调度器在主进程 session-manager，vitest 开不了真 DB）。 */

const NOW = 1_800_000_000_000
const idle = (minsAgo: number) => NOW - minsAgo * 60_000

describe('judgeSweepCandidate 资格矩阵（用户点名的两条 + 防抖/活跃窗）', () => {
  it('游标到头（近期已提取）→ skip-current', () => {
    expect(judgeSweepCandidate({ totalTextMessages: 20, cursor: 20, lastActiveAt: idle(60) }, NOW)).toBe('skip-current')
  })
  it('总轮数 < 5 → skip-thin', () => {
    expect(judgeSweepCandidate({ totalTextMessages: 4, cursor: 0, lastActiveAt: idle(60) }, NOW)).toBe('skip-thin')
  })
  it('未处理增量 < 4 → wait-accumulate（攒到下轮，游标不动）', () => {
    expect(judgeSweepCandidate({ totalTextMessages: 20, cursor: 18, lastActiveAt: idle(60) }, NOW)).toBe('wait-accumulate')
    expect(judgeSweepCandidate({ totalTextMessages: 20, cursor: 16, lastActiveAt: idle(60) }, NOW)).toBe('extract') // delta=4 恰好达标
  })
  it('30 分钟内活跃 → skip-active（可能正在使用）', () => {
    expect(judgeSweepCandidate({ totalTextMessages: 20, cursor: 0, lastActiveAt: idle(10) }, NOW)).toBe('skip-active')
    expect(judgeSweepCandidate({ totalTextMessages: 20, cursor: 0, lastActiveAt: NOW - SWEEP_ACTIVE_WINDOW_MS - 1 }, NOW)).toBe('extract')
  })
  it('活跃会话无论增量一律让路（活跃窗先判——两种判定都推迟，语义取后者）', () => {
    expect(judgeSweepCandidate({ totalTextMessages: 6, cursor: 5, lastActiveAt: idle(1) }, NOW)).toBe('skip-active')
  })
})

describe('sweepIntervalMs（间隔语义）', () => {
  it('默认 6h；显式数值生效', () => {
    expect(sweepIntervalMs(undefined)).toBe(DEFAULT_MEMORY_EXTRACT_INTERVAL_HOURS * 3600_000)
    expect(sweepIntervalMs(1)).toBe(3600_000)
    expect(sweepIntervalMs(0.5)).toBe(1800_000)
  })
  it('0 = 关闭定时（仅手动）；非法回落默认', () => {
    expect(sweepIntervalMs(0)).toBeNull()
    expect(sweepIntervalMs(-3)).toBe(6 * 3600_000) // 非法回落默认（设置层归一化已夹 ≥0，此为兜底）
    expect(sweepIntervalMs(Number.NaN)).toBe(6 * 3600_000)
  })
})

describe('接线（wiring 扫描）', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('调度器宿主在主进程 session-manager：启动接线 + 定时重排 + 手动入口', () => {
    const src = read('src/main/agent/session-manager.ts')
    expect(src).toContain('scheduleMemorySweep()')
    expect(src).toContain('runMemoryExtractionSweep')
    expect(src).toContain('judgeSweepCandidate')
    expect(src).toContain('setMemorySweepTrigger')
    expect(src).toContain('this.scheduleMemorySweep() // 间隔设置变更后重排定时器')
  })
  it('afterSession 与启动回填不再触发 LLM 提取（两条退役路径）', () => {
    const sm = read('src/main/agent/session-manager.ts')
    expect(sm).not.toContain("await managers.memoryManager.extractAndSaveAll(")
    const app = read('src/renderer/src/App.tsx')
    expect(app).not.toContain('extractAndSaveAll')
    const ctl = read('src/renderer/src/hooks/useChatController.ts')
    expect(ctl).not.toContain('extractAndSaveAll')
  })
  it('提取调用只剩调度器一处（runMemoryExtractionSweep 内）', () => {
    const sm = read('src/main/agent/session-manager.ts')
    expect((sm.match(/extractAndSaveAll/g) ?? []).length).toBe(1)
  })
  it('手动触发 IPC 全链在位（通道/handler/preload/bridge）', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("MEMORY_SWEEP_RUN: 'memory-sweep:run'")
    expect(read('src/main/ipc/memory.handler.ts')).toContain('setMemorySweepTrigger')
    expect(read('src/preload/index.ts')).toContain('runMemorySweepNow')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('runMemorySweepNow')
  })
})
