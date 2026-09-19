// 命令面板的纯逻辑（navigation/command-palette-items.ts）：构建顺序、
// 子序列过滤与打分。构建/过滤无 React、无 antd —— 直接驱动。

import { describe, expect, it } from 'vitest'
import { buildCommandItems, filterCommandItems, fuzzyScore, type CommandPaletteSources } from '../src/renderer/src/navigation/command-palette-items'

function sources(overrides: Partial<CommandPaletteSources> = {}): CommandPaletteSources {
  return {
    labels: {
      groupActions: '操作',
      groupViews: '视图',
      groupConversations: '会话',
      groupProjects: '项目',
      groupSettings: '设置',
      newTask: '新建任务',
      newProject: '新建项目',
      toggleSidebar: '收起 / 展开侧边栏',
      toggleWorkbench: '打开 / 收起工作台',
      openSearch: '打开搜索',
      openUsage: '打开用量统计',
      openSettings: '打开设置',
      openConversation: '打开会话 · ',
      newTaskInProject: '在项目中新建任务 · ',
      settingsSection: '设置 · ',
    },
    hints: { newTask: '⌘N' },
    conversations: [
      { key: 'c1', label: '部署脚本排查' },
      { key: 'c2', label: '' }, // 空标题回落到前缀 + key
    ],
    projects: [{ id: 'p1', name: 'PulseMind' }],
    settingsSections: [
      { key: 'environment', label: '环境变量' },
      { key: 'about', label: '关于' },
    ],
    run: {
      newTask: () => {},
      newProject: () => {},
      toggleSidebar: () => {},
      toggleWorkbench: () => {},
      openSearch: () => {},
      openUsage: () => {},
      openSettings: () => {},
      openSettingsSection: () => {},
      openConversation: () => {},
      newTaskInProject: () => {},
    },
    ...overrides,
  }
}

describe('buildCommandItems', () => {
  const items = buildCommandItems(sources())

  it('顺序：动作 → 视图 → 会话 → 项目 → 设置；空标题会话回落到前缀', () => {
    const groups = items.map((i) => i.group)
    const firstOf = (g: string) => groups.indexOf(g)
    expect(firstOf('操作')).toBeLessThan(firstOf('视图'))
    expect(firstOf('视图')).toBeLessThan(firstOf('会话'))
    expect(firstOf('会话')).toBeLessThan(firstOf('项目'))
    expect(firstOf('项目')).toBeLessThan(firstOf('设置'))
    expect(items.find((i) => i.id === 'conv:c2')?.label).toBe('打开会话 · c2')
  })

  it('每个闭包捕获自己的目标：openConversation / newTaskInProject / settingsSection', () => {
    const seen: string[] = []
    const items2 = buildCommandItems(
      sources({
        run: {
          ...sources().run,
          openConversation: (key) => seen.push(`conv:${key}`),
          newTaskInProject: (id) => seen.push(`project:${id}`),
          openSettingsSection: (tab) => seen.push(`settings:${tab}`),
        },
      }),
    )
    items2.find((i) => i.id === 'conv:c1')!.run()
    items2.find((i) => i.id === 'project:p1')!.run()
    items2.find((i) => i.id === 'settings:about')!.run()
    expect(seen).toEqual(['conv:c1', 'project:p1', 'settings:about'])
  })

  it('hint 是展示性的：给了就带，不给就缺省', () => {
    expect(items.find((i) => i.id === 'action:new-task')?.hint).toBe('⌘N')
    expect(items.find((i) => i.id === 'action:open-search')?.hint).toBeUndefined()
  })
})

describe('filterCommandItems', () => {
  const items = buildCommandItems(sources())

  it('空查询原样返回全部（保序）', () => {
    expect(filterCommandItems(items, '')).toEqual(items)
    expect(filterCommandItems(items, '   ')).toEqual(items)
  })

  it('子序列命中：乱序字符也能找到', () => {
    const ids = filterCommandItems(items, '新建').map((i) => i.id)
    expect(ids).toContain('action:new-task')
    expect(ids).toContain('action:new-project')
    expect(ids).not.toContain('action:open-search')
  })

  it('打分偏好前缀+连续：「设置」把 设置 分区条目排到 打开设置 前', () => {
    const ids = filterCommandItems(items, '设置').map((i) => i.id)
    // '设置 · 环境变量' 命中在开头（前缀 + 连续），'打开设置' 命中在串中间
    expect(ids.indexOf('settings:environment')).toBeLessThan(ids.indexOf('action:open-settings'))
    // 同分保持构建顺序（稳定排序）
    expect(ids.indexOf('settings:environment')).toBeLessThan(ids.indexOf('settings:about'))
  })

  it('前缀命中加分：搜索 把 打开搜索 顶到第一', () => {
    const first = filterCommandItems(items, '搜索')[0]
    expect(first.id).toBe('action:open-search')
  })

  it('无命中返回空数组（组件据此渲染空态）', () => {
    expect(filterCommandItems(items, '完全不存在的词')).toEqual([])
  })
})

describe('fuzzyScore', () => {
  it('连续命中高于散落命中', () => {
    // '工具台' 里 工具 紧挨着；'工某具' 里被隔开
    expect(fuzzyScore('工具台', '工具')).toBeGreaterThan(fuzzyScore('工某具', '工具'))
  })
  it('首字符多种匹配窗口取最优', () => {
    // 'ab' 在 'xaxbb' 里有两个种子；b 紧跟 a 的那条更高
    expect(fuzzyScore('xaxbb', 'ab')).toBeGreaterThan(0)
  })
  it('缺失字符得 0 分', () => {
    expect(fuzzyScore('abc', 'abd')).toBe(0)
  })
  it('空查询得 1（全通过）', () => {
    expect(fuzzyScore('anything', '')).toBe(1)
  })
})
