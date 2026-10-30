/**
 * ChatView 的 hideWorkbench / hideTaskSwitcher（项目沉浸窗口，2026-10-30）。
 *
 * 项目窗口把文件面自己放在左侧（ProjectExplorer = WorkspacePane），所以这列
 * 绝不能再停靠一份：WorkbenchPane 在本组件 root 内是绝对定位的，一旦 open 就会
 * 盖住对话列。同时欢迎表单的 对话/项目 切换器要让位 —— 宿主已经把项目钉住，
 * 那个切换器会给任务留一条逃出项目的路。
 *
 * 折进一个有效标志（workbenchOpen = raw && !hideWorkbench）是刻意的：预留宽度、
 * slim 计划条、两处自动打开 effect 全都读同一个值，不会各自漏判。
 *
 * 本文件钉：两个 prop 的声明与消费点 + 三处渲染守卫 + 阴性对照（删掉任一守卫
 * 即红）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/components/layout/ChatView.tsx'), 'utf8')

describe('ChatView hideWorkbench', () => {
  it('declares both props', () => {
    const src = read()
    expect(src).toContain('hideWorkbench?: boolean')
    expect(src).toContain('hideTaskSwitcher?: boolean')
    expect(src).toContain('hideWorkbench,')
    expect(src).toContain('hideTaskSwitcher,')
  })

  it('folds the flag into the effective open state (one source of truth)', () => {
    const src = read()
    // The store read stays unconditional (rules of hooks) — the AND happens after.
    expect(src).toContain('const workbenchOpenRaw = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)')
    expect(src).toContain('const workbenchOpen = workbenchOpenRaw && !hideWorkbench')
  })

  it('the pane is not rendered, so its absolute position cannot cover the chat', () => {
    const src = read()
    expect(src).toContain('{!hideWorkbench && (')
    // The guard must sit immediately before the pane's JSX.
    const guard = src.indexOf('{!hideWorkbench && (')
    expect(src.indexOf('<WorkbenchPane', guard)).toBeGreaterThan(guard)
  })

  it('the slim plan strip is hidden with it (its click opens an invisible pane)', () => {
    const src = read()
    expect(src).toContain('planTotal > 0 && !workbenchOpen && !hideWorkbench ? (')
    expect(src).toContain('workbenchOpen, wbKey, hideWorkbench]')
  })

  it('the welcome task switcher is hideable', () => {
    const src = read()
    expect(src).toContain('{!hideTaskSwitcher && (')
    const guard = src.indexOf('{!hideTaskSwitcher && (')
    expect(src.indexOf('data-welcome-switcher', guard)).toBeGreaterThan(guard)
  })

  it('the project window asks for both', () => {
    const pop = readFileSync(
      join(process.cwd(), 'src/renderer/src/popout/PopoutApp.tsx'),
      'utf8',
    )
    expect(pop).toContain('hideWorkbench={isProjectWindow}')
    expect(pop).toContain('hideTaskSwitcher={isProjectWindow}')
  })
})
