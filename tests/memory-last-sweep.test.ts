import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 上次自动记忆提取时刻（2026-10-28 用户要求「面板中展示上一次自动记忆提取的
 *  时间」）。stamp 落 settings.memoryLastSweepAt——sweep 真跑完才写（早退分支：
 *  总开关全关/无可用 profile，不算跑过）；渲染端整存由 SETTINGS_SET 保留（主进程
 *  随时落笔、渲染端快照必旧，last-used 同款）；面板行走 describeRelativeTimeText
 *  的 60s 相对时钟。断一处，展示行就停在启动快照上或被整存回滚。 */

const read = (p: string) => readFileSync(p, 'utf-8')

describe('上次记忆提取时刻接线', () => {
  it('session-manager：stamp 在 runMemoryExtractionSweep 的收尾（候选循环之后）', () => {
    const src = read('src/main/agent/session-manager.ts')
    const stamp = 'await settingsStore.update((s) => ({ ...s, memoryLastSweepAt: new Date().toISOString() }))'
    expect(src).toContain(stamp)
    // 落笔点属于提取清扫本体，且在其 return 之前——不是任意 update 都算数
    const sweepBody = src.slice(src.indexOf('private async runMemoryExtractionSweep'))
    expect(sweepBody.indexOf(stamp)).toBeLessThan(sweepBody.indexOf('private async runSopDistillSweep'))
  })

  it('SETTINGS_SET 整存保留运行态时间戳（快照回滚防线）', () => {
    const src = read('src/main/ipc/settings.handler.ts')
    expect(src).toContain('settings.memoryLastSweepAt = current.memoryLastSweepAt')
  })

  it('settings-store：get() 逐字段重建带上归一化', () => {
    const src = read('src/main/storage/settings-store.ts')
    expect(src).toContain("memoryLastSweepAt: typeof parsed.memoryLastSweepAt === 'string' ? parsed.memoryLastSweepAt : undefined")
  })

  it('MemorySettings：相对时钟展示 + 打开时与手动提取后各取新鲜值', () => {
    const src = read('src/renderer/src/components/settings/MemorySettings.tsx')
    expect(src).toContain('describeRelativeTimeText(lastSweepAt, now, t)')
    expect(src).toContain("t('memoryDrawer.lastSweep'")
    expect(src).toContain("t('memoryDrawer.lastSweepNever')")
    // 展示值不读启动快照：打开面板与手动提取后都走 getSettings 取新鲜值
    expect(src).toContain('await window.electronAPI.getSettings()')
    expect(src).toContain('if (open) void loadLastSweep()')
    expect(src).toContain('await loadLastSweep()')
  })

  it('i18n 双语键在位', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('lastSweep:')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('lastSweep:')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('lastSweepNever:')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('lastSweepNever:')
  })
})
