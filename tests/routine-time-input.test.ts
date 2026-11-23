// 定时执行时间滚轮的落值契约（user 2026-11-23：「我改不了日常任务里的定时
// 执行的时间滚轮，一直是9:00」）。
//
// antd v6 把 needConfirm 的缺省翻成 true（rc-picker 的
// mergedNeedConfirm = needConfirm ?? multipleInteractivePicker，time 属于
// multipleInteractivePicker），而 time 又是 complexPicker —— 点列只改面板
// 暂存值，onChange 要等 footer 的 ✓ 或者干脆不落；用户点完时间点外面，值就
// 被悄悄退回 09:00（v5 是点列即落）。现行契约写在 TimeInput 上：显式
// needConfirm={false} 撤掉 ✓，onCalendarChange 让每次点列立刻进草稿（下次
// 运行提示同步走），两条路径都对当前值去重（workflow 侧每次草稿变更压一个
// undo 帧）。
//
// vitest 是 node-env（不起真面板），所以只钉源码契约；行为证据（真点小时/
// 分钟列 → 草稿变 10:30 → 点外关闭不回退）在
// scripts/probe-routine-schedule.mjs §1b（7 checks）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const form = readFileSync(join(ROOT, 'src/renderer/src/components/routine/RoutineForm.tsx'), 'utf-8')

describe('TimeInput：点列即落草稿', () => {
  it('needConfirm={false}：撤掉 footer，点外关闭也提交', () => {
    expect(form).toContain('needConfirm={false}')
  })

  it('onCalendarChange 与 onChange 共用同一次提交（点列立刻生效）', () => {
    // 只有 needConfirm={false} 时点列仍只在关闭时落值；两条都接才是 v5 的
    // 「点一下就是它」手感。
    expect(form).toMatch(/onCalendarChange=\{commit\}/)
    expect(form).toMatch(/\n\s+onChange=\{commit\}/)
  })

  it('提交对当前值去重，且清空回落 09:00', () => {
    expect(form).toContain('if (next !== value) onChange(next)')
    expect(form).toContain('?? DEFAULT_TIME')
  })
})
