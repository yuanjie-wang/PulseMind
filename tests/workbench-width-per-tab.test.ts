// ── 面板宽度按 tab 分开（2026-11-06 用户裁定）──
// 此前 width 是一个全局单标量：浏览器 tab 被拖宽到 800 之后，工作计划/工作区
// 的面板被同一个数字撑开——而且这个值跨会话、跨重启原样带到 plan/todo 的自动
// 弹出上，于是「一触发 todo list / create plan 就弹出一个过宽的面板」。改成
// widthByTab 之后钉四件事：
//   ① 每个 tab 一份，缺键回落 WORKBENCH_DEFAULT_WIDTH；
//   ② setWidth 缺省写当前 activeTab（拖拽手拖的是眼前这张面板）；
//   ③ v1 持久化（单标量 width）迁移时**只继承给 browser**（用户裁定：浏览器
//      保留调过的宽带，工作计划/工作区回默认）；
//   ④ 五个几何消费点全走 useWorkbenchWidth —— 少一个，对话列 reserve 与 pane
//      宽度就会错位（多一条缝，或 drill-in 覆盖层压到 pane 上）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  useWorkbenchStore,
  widthForTab,
  migrateWorkbenchPersisted,
  workbenchPersistShape,
  WORKBENCH_DEFAULT_WIDTH,
} from '../src/renderer/src/stores/workbenchStore'

const ROOT = join(__dirname, '..')

const migrateOf = () => migrateWorkbenchPersisted as (state: unknown, version: number) => Record<string, unknown>

beforeEach(() => {
  useWorkbenchStore.setState({ widthByTab: {}, activeTab: 'workspace' })
})

describe('widthForTab: 每个 tab 一份，缺键回落默认值', () => {
  it('无键 → 默认宽度（不是浏览器的那份）', () => {
    expect(widthForTab({}, 'plan')).toBe(WORKBENCH_DEFAULT_WIDTH)
    expect(widthForTab({}, 'browser')).toBe(WORKBENCH_DEFAULT_WIDTH)
  })

  it('tab 之间隔离：拖宽浏览器不动计划面板', () => {
    const w = { browser: 800, plan: 520 }
    expect(widthForTab(w, 'browser')).toBe(800)
    expect(widthForTab(w, 'plan')).toBe(520)
    expect(widthForTab(w, 'workspace')).toBe(WORKBENCH_DEFAULT_WIDTH)
  })

  it('非有限值当缺键（脏持久化不把面板撑成 Infinity/NaN）', () => {
    expect(widthForTab({ plan: Number.NaN }, 'plan')).toBe(WORKBENCH_DEFAULT_WIDTH)
    expect(widthForTab({ plan: Number.POSITIVE_INFINITY }, 'plan')).toBe(WORKBENCH_DEFAULT_WIDTH)
  })
})

describe('setWidth: 缺省写当前 activeTab', () => {
  it('拖拽只改眼前这张面板的宽度', () => {
    useWorkbenchStore.getState().setActiveTab('browser')
    useWorkbenchStore.getState().setWidth(800)
    expect(useWorkbenchStore.getState().widthByTab).toEqual({ browser: 800 })

    useWorkbenchStore.getState().setActiveTab('plan')
    useWorkbenchStore.getState().setWidth(600)
    expect(useWorkbenchStore.getState().widthByTab).toEqual({ browser: 800, plan: 600 })
    // 两个 tab 各自持有自己的那份，互不覆盖
    expect(widthForTab(useWorkbenchStore.getState().widthByTab, 'browser')).toBe(800)
    expect(widthForTab(useWorkbenchStore.getState().widthByTab, 'plan')).toBe(600)
  })

  it('显式 tab 参数优先于 activeTab', () => {
    useWorkbenchStore.getState().setActiveTab('plan')
    useWorkbenchStore.getState().setWidth(700, 'workspace')
    expect(useWorkbenchStore.getState().widthByTab).toEqual({ workspace: 700 })
  })
})

describe('persist v1 → v2：旧单标量只继承给 browser', () => {
  it('v1 的 width 落进 browser，width 键被剔除', () => {
    const out = migrateOf()({ width: 812, activeTab: 'plan', treeWidth: 200 }, 1)
    expect(out.widthByTab).toEqual({ browser: 812 })
    expect('width' in out).toBe(false)
    // 其余持久化字段原样保留
    expect(out.activeTab).toBe('plan')
    expect(out.treeWidth).toBe(200)
  })

  it('v1 缺 width / 值为 NaN → 不写坏键，全部回落默认', () => {
    expect(migrateOf()({ activeTab: 'workspace' }, 1).widthByTab).toEqual({})
    expect(migrateOf()({ width: Number.NaN }, 1).widthByTab).toEqual({})
  })

  it('已是 v2 的持久化原样透传（不重复迁移）', () => {
    const v2 = { widthByTab: { browser: 700 }, activeTab: 'browser' }
    expect(migrateOf()(v2, 2)).toEqual(v2)
  })
})

describe('partialize：只落 widthByTab，不再写单标量', () => {
  it('落盘形状', () => {
    useWorkbenchStore.getState().setWidth(510, 'plan')
    const out = workbenchPersistShape(useWorkbenchStore.getState()) as unknown as Record<string, unknown>
    expect(out.widthByTab).toEqual({ plan: 510 })
    expect('width' in out).toBe(false)
  })
})

describe('五个几何消费点共用同一个读数口子', () => {
  const consumers = [
    'src/renderer/src/components/workbench/WorkbenchPane.tsx',
    'src/renderer/src/components/layout/ChatView.tsx',
    'src/renderer/src/App.tsx',
    'src/renderer/src/popout/PopoutApp.tsx',
    'src/renderer/src/hooks/useBrowserPane.ts',
  ]

  it('每个消费点都走 useWorkbenchWidth，且没人再裸读 s.width', () => {
    for (const file of consumers) {
      const src = readFileSync(join(ROOT, file), 'utf-8')
      expect(src, file).toContain('useWorkbenchWidth()')
      expect(src, file).not.toContain('useWorkbenchStore((s) => s.width)')
    }
  })
})
