// ── 面板宽度按会话独立（2026-11-12 用户裁定，同日二次裁定收口）──
// 第一刀：宽度与 tab 选中按会话独立（此前宽度是全局 per-tab、tab 选中是单一
// 全局值——会话 A 的几何顶掉会话 B 的）。第二刀（user「如果已经打开侧边窗口
// 的状态下，切tab，不要再改变宽度了」）：宽度收敛成**每会话一份标量**——
// 2026-11-06 的按 tab 维度整个退役，切 tab 只换 body 不换几何，宽度只随拖拽
// 走。钉五件事：
//   ① widthForConversation 是无 tab 参数的会话标量读数：缺键/非有限值回落
//      WORKBENCH_DEFAULT_WIDTH，会话之间互不串；
//   ② setActiveTab（切 tab）不触碰宽度 map——「切 tab 不改宽」的行为面；
//   ③ setWidth 是唯一的写路径（convKey + 标量），MRU 剪枝同 open/primary；
//   ④ v1→v2→v3 迁移链：v3 把全局 activeTab 与 v2 的 widthByTab 一并剥除
//      （per-tab 值在新标量模型里没有载体），落盘形状只剩
//      widthByConversation + treeWidth；
//   ⑤ 五个几何消费点全走 useWorkbenchWidth(<会话键>) —— 少一个，对话列
//      reserve 与 pane 宽度就会错位（多一条缝，或覆盖层压到 pane 上）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  useWorkbenchStore,
  widthForConversation,
  activeTabOf,
  migrateWorkbenchPersisted,
  workbenchPersistShape,
  WORKBENCH_DEFAULT_WIDTH,
} from '../src/renderer/src/stores/workbenchStore'

const ROOT = join(__dirname, '..')
const STORE_SRC = join(ROOT, 'src/renderer/src/stores/workbenchStore.ts')

const migrateOf = () => migrateWorkbenchPersisted as (state: unknown, version: number) => Record<string, unknown>

beforeEach(() => {
  useWorkbenchStore.setState({ widthByConversation: {}, activeTabByConversation: {} })
})

describe('widthForConversation: 每会话一份标量', () => {
  it('会话之间隔离：A 拖到 800，B 回默认', () => {
    const s = { widthByConversation: { conv_a: 800 } }
    expect(widthForConversation(s, 'conv_a')).toBe(800)
    expect(widthForConversation(s, 'conv_b')).toBe(WORKBENCH_DEFAULT_WIDTH)
  })

  it('无会话键 → 默认值', () => {
    expect(widthForConversation({ widthByConversation: { conv_a: 800 } }, undefined)).toBe(WORKBENCH_DEFAULT_WIDTH)
  })

  it('非有限值当缺键（脏持久化不把面板撑成 Infinity/NaN）', () => {
    expect(widthForConversation({ widthByConversation: { conv_a: Number.NaN } }, 'conv_a')).toBe(WORKBENCH_DEFAULT_WIDTH)
    expect(widthForConversation({ widthByConversation: { conv_a: Number.POSITIVE_INFINITY } }, 'conv_a')).toBe(WORKBENCH_DEFAULT_WIDTH)
  })

  it('读数不带 tab 维度：状态与落盘里没有 per-tab 字段（迁移函数提及 widthByTab 只为剥除）', () => {
    const src = readFileSync(STORE_SRC, 'utf-8')
    expect(src).not.toContain('widthForTab')
    expect(src).not.toContain('WorkbenchWidthByTab')
    // 状态接口与落盘形状都不再有该字段；唯一合法的出现处是 migrate 的 v2→v3 剥除。
    expect(src).not.toContain('widthByTab: Record')
    expect(src).not.toContain('widthByTab: s.')
  })
})

describe('切 tab 不改宽：setActiveTab 与宽度 map 零交互', () => {
  it('切 tab 前后 widthByConversation 逐字节不变', () => {
    useWorkbenchStore.getState().setWidth('conv_a', 800)
    const before = useWorkbenchStore.getState().widthByConversation
    useWorkbenchStore.getState().setActiveTab('conv_a', 'browser')
    useWorkbenchStore.getState().setActiveTab('conv_a', 'plan')
    expect(useWorkbenchStore.getState().widthByConversation).toEqual(before)
    expect(widthForConversation(useWorkbenchStore.getState(), 'conv_a')).toBe(800)
  })

  it('openTab / setConversationPrimary 同样不碰宽度', () => {
    useWorkbenchStore.getState().setWidth('conv_a', 700)
    useWorkbenchStore.getState().openTab('conv_a', 'plan')
    useWorkbenchStore.getState().setConversationPrimary('conv_a', 'browser')
    expect(widthForConversation(useWorkbenchStore.getState(), 'conv_a')).toBe(700)
  })
})

describe('setWidth: 唯一写路径（会话标量）', () => {
  it('拖拽写自己会话的标量，别的会话不受牵连', () => {
    useWorkbenchStore.getState().setWidth('conv_a', 800)
    useWorkbenchStore.getState().setWidth('conv_b', 500)
    expect(useWorkbenchStore.getState().widthByConversation).toEqual({ conv_a: 800, conv_b: 500 })
  })

  it('widthByConversation 与 open/primary/tab 同款 MRU 剪枝（帽 20）', () => {
    for (let i = 0; i < 21; i++) useWorkbenchStore.getState().setWidth(`conv_${i}`, 500 + i)
    const map = useWorkbenchStore.getState().widthByConversation
    expect('conv_0' in map).toBe(false)
    expect(map.conv_20).toBe(520)
    expect(Object.keys(map).length).toBe(20)
  })

  it('activeTabByConversation 同款 MRU 剪枝', () => {
    for (let i = 0; i < 21; i++) useWorkbenchStore.getState().setActiveTab(`conv_${i}`, 'plan')
    const map = useWorkbenchStore.getState().activeTabByConversation
    expect('conv_0' in map).toBe(false)
    expect(map.conv_20).toBe('plan')
  })
})

describe('activeTabOf: tab 选中按会话独立（第一刀裁定保持）', () => {
  it('无条目回落 workspace；会话之间互不串', () => {
    expect(activeTabOf({ activeTabByConversation: {} }, 'conv_a')).toBe('workspace')
    expect(activeTabOf({ activeTabByConversation: {} }, undefined)).toBe('workspace')
    const s = { activeTabByConversation: { conv_a: 'browser', conv_b: 'plan' } }
    expect(activeTabOf(s, 'conv_a')).toBe('browser')
    expect(activeTabOf(s, 'conv_b')).toBe('plan')
  })
})

describe('persist v1 → v2 → v3 迁移链', () => {
  it('v1 直达终态：单标量 width 没有会话载体，全部回落默认（中间的 v2 形态不可观察）', () => {
    const out = migrateOf()({ width: 812, activeTab: 'plan', treeWidth: 200 }, 1)
    expect(out.widthByConversation).toEqual({})
    expect('width' in out).toBe(false)
    expect('widthByTab' in out).toBe(false)
    expect('activeTab' in out).toBe(false)
    expect(out.treeWidth).toBe(200)
  })

  it('v2 → v3：全局 activeTab 与 widthByTab 一并剥除，widthByConversation 空表起步', () => {
    const out = migrateOf()({ widthByTab: { browser: 700 }, activeTab: 'browser', treeWidth: 200 }, 2)
    expect(out.widthByConversation).toEqual({})
    expect('activeTab' in out).toBe(false)
    expect('widthByTab' in out).toBe(false)
    expect(out.treeWidth).toBe(200)
  })

  it('v1 直达 v3（两跳串联，中转值不残留）', () => {
    const out = migrateOf()({ width: 812, activeTab: 'plan' }, 1)
    expect(out.widthByConversation).toEqual({})
    expect('activeTab' in out).toBe(false)
    expect('widthByTab' in out).toBe(false)
  })

  it('已是 v3 的持久化原样透传（不重复迁移）', () => {
    const v3 = { widthByConversation: { conv_a: 700 }, treeWidth: 200 }
    expect(migrateOf()(v3, 3)).toEqual(v3)
  })
})

describe('partialize：只落 widthByConversation + treeWidth', () => {
  it('落盘形状：tab 选中与 open/primary 一律不写，v2 的 widthByTab 不再写回', () => {
    useWorkbenchStore.getState().setActiveTab('conv_a', 'plan')
    useWorkbenchStore.getState().setWidth('conv_a', 510)
    useWorkbenchStore.getState().setOpen('conv_a', true)
    const out = workbenchPersistShape(useWorkbenchStore.getState()) as unknown as Record<string, unknown>
    expect(out.widthByConversation).toEqual({ conv_a: 510 })
    expect(out.treeWidth).toBeDefined()
    expect('activeTab' in out).toBe(false)
    expect('widthByTab' in out).toBe(false)
    expect('activeTabByConversation' in out).toBe(false)
    expect('openByConversation' in out).toBe(false)
    expect('primaryByConversation' in out).toBe(false)
  })
})

describe('五个几何消费点共用同一个读数口子（带会话键）', () => {
  const consumers = [
    'src/renderer/src/components/workbench/WorkbenchPane.tsx',
    'src/renderer/src/components/layout/ChatView.tsx',
    'src/renderer/src/App.tsx',
    'src/renderer/src/popout/PopoutApp.tsx',
    'src/renderer/src/hooks/useBrowserPane.ts',
  ]

  it('每个消费点都走 useWorkbenchWidth(<key>)，无人裸读宽度或无参调用', () => {
    for (const file of consumers) {
      const src = readFileSync(join(ROOT, file), 'utf-8')
      expect(src, file).toContain('useWorkbenchWidth(')
      expect(src, file).not.toContain('useWorkbenchWidth()')
      expect(src, file).not.toContain('useWorkbenchStore((s) => s.width')
      expect(src, file).not.toContain('s.widthByTab')
    }
  })
})
