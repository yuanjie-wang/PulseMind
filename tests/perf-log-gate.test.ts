// ── perf-log.ts 的门控真值表（2026-09-21 审查 M1）──
// perfTime 有三个出口，缺一不可：PM_PERF=1（任何环境）、真 Electron 的 dev
// （vitest 的 electron stub 恰好 isPackaged:false，与真 dev 同路）、打包版且
// debugPerfLogs 已热。旧实现把打包分支写在 `!realElectronDev()` 早退之后，
// 打包分支不可达 —— 设置项在打包版是死开关。本文件逐行钉住三个出口，其中
// 「打包版 + 开关开」这一行对旧实现正好是红的（非空验证）。
//
// 环境建模：PM_PERF 走 process.env；isPackaged 走 electron stub 的可变对象
// （undefined = ELECTRON_RUN_AS_NODE 的「app 是路径字符串」形态）；
// debugPerfLogs 走 vi.doMock 的 settingsStore.get。每个 case 先 resetModules
// 再 doMock 再动态导入，模块级缓存（cachedPackaged/lastCheck）随之归零。
import { afterEach, describe, expect, it, vi } from 'vitest'

let currentSetting: Record<string, unknown> = {}

type PerfLog = typeof import('../src/main/perf/perf-log')

async function loadGate(opts: { pmPerf?: string; isPackaged?: boolean }): Promise<PerfLog> {
  vi.resetModules()
  currentSetting = {}
  vi.doMock('../src/main/storage/settings-store', () => ({
    settingsStore: { get: vi.fn(async () => currentSetting) },
  }))
  if (opts.pmPerf === undefined) delete process.env.PM_PERF
  else process.env.PM_PERF = opts.pmPerf
  const electron = await import('electron')
  // `in`, not `??`: an explicit undefined IS the case under test (the
  // ELECTRON_RUN_AS_NODE shape where app.isPackaged reads as nothing).
  ;(electron.app as { isPackaged?: boolean }).isPackaged = 'isPackaged' in opts ? opts.isPackaged : false
  return import('../src/main/perf/perf-log')
}

function spyPerfLine(): { seen: () => boolean; restore: () => void } {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return {
    seen: () => log.mock.calls.some((args) => typeof args[0] === 'string' && args[0].startsWith('[perf] ')),
    restore: () => log.mockRestore(),
  }
}

afterEach(() => {
  delete process.env.PM_PERF
  vi.restoreAllMocks()
})

describe('perfTime gate truth table', () => {
  it('PM_PERF=1 turns the gate on in any environment', async () => {
    const { perfTime } = await loadGate({ pmPerf: '1', isPackaged: true })
    const s = spyPerfLine()
    perfTime('env', () => 1)
    expect(s.seen()).toBe(true)
    s.restore()
  })

  it('a real (or stubbed) electron dev build is on without any setting', async () => {
    const { perfTime } = await loadGate({ isPackaged: false })
    const s = spyPerfLine()
    perfTime('dev', () => 1)
    expect(s.seen()).toBe(true)
    s.restore()
  })

  it('outside electron (app is not an object) it stays off — the PM_PERF-only row', async () => {
    const { perfTime } = await loadGate({ isPackaged: undefined })
    const s = spyPerfLine()
    perfTime('node', () => 1)
    expect(s.seen()).toBe(false)
    s.restore()
  })

  it('packaged + debugPerfLogs on: a cold cache stays silent for one call, then honours the flag', async () => {
    vi.resetModules()
    vi.doMock('../src/main/storage/settings-store', () => ({
      settingsStore: { get: vi.fn(async () => currentSetting) },
    }))
    delete process.env.PM_PERF
    const electron = await import('electron')
    ;(electron.app as { isPackaged?: boolean }).isPackaged = true
    currentSetting = { debugPerfLogs: true }
    const { perfTime } = await import('../src/main/perf/perf-log')

    const s = spyPerfLine()
    perfTime('cold', () => 1)
    expect(s.seen(), 'cold cache must not await the store — this round stays off').toBe(false)
    // The background read lands on the next macrotask; from then on the flag rules.
    await new Promise((r) => setTimeout(r, 0))
    perfTime('warm', () => 1)
    expect(s.seen(), 'warmed cache must honour debugPerfLogs — this line is the M1 fix').toBe(true)
    s.restore()
  })

  it('packaged + debugPerfLogs off stays off', async () => {
    vi.resetModules()
    vi.doMock('../src/main/storage/settings-store', () => ({
      settingsStore: { get: vi.fn(async () => currentSetting) },
    }))
    delete process.env.PM_PERF
    const electron = await import('electron')
    ;(electron.app as { isPackaged?: boolean }).isPackaged = true
    currentSetting = {}
    const { perfTime } = await import('../src/main/perf/perf-log')

    const s = spyPerfLine()
    perfTime('off', () => 1)
    await new Promise((r) => setTimeout(r, 0))
    perfTime('off-again', () => 1)
    expect(s.seen()).toBe(false)
    s.restore()
  })
})
