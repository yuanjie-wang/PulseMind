// ── 手动打开工作台的 tab 落点 ──
// 2026-09-17 用户裁定的旧契约（主动打开恒落「工作区」）已被 2026-11-12 的
// 「tab 选中状态每个会话独立管理」修订：开臂只补开（setOpen），重开恢复**该
// 会话**记住的 tab；无记忆（新会话/DRAFT）回落 workspace——旧裁定防的「打开
// 落在一个陈旧 tab」在新形态下仍成立（tab 记忆按会话、写路径都过
// reconcileActiveTab，removed tab 渲染不出空 body）。
//
// 三条腿，互不覆盖（vitest 是 node 环境，组件挂不了）：store 的 openTab /
// setOpen 语义在这里真跑；「按钮的打开分支走的是 setOpen 而不是 openTab」是
// 接线事实，只能扫源码——见 tests/pending-approval.test.ts 的同一手法。

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  useWorkbenchStore,
  activeTabOf,
} from '../src/renderer/src/stores/workbenchStore'

const KEY = 'conv_test'

describe('workbenchStore (manual-open contract)', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openByConversation: {},
      widthByConversation: {},
      activeTabByConversation: {},
    })
  })

  it('openTab opens the pane and brings the named tab to the front (this conversation only)', () => {
    useWorkbenchStore.getState().openTab(KEY, 'workspace')
    const s = useWorkbenchStore.getState()
    expect(s.openByConversation[KEY]).toBe(true)
    expect(activeTabOf(s, KEY)).toBe('workspace')
    // 别的会话不受牵连。
    expect(activeTabOf(s, 'conv_other')).toBe('workspace')
  })

  it('closing remembers the tab, so re-opening via setOpen restores it', () => {
    useWorkbenchStore.getState().openTab(KEY, 'browser')
    useWorkbenchStore.getState().setOpen(KEY, false)
    // 收起不动 tab 记忆：重开看到的就是该会话记住的那张。
    expect(activeTabOf(useWorkbenchStore.getState(), KEY)).toBe('browser')
    // 开臂 = 纯补开：tab 记忆不被改写。
    useWorkbenchStore.getState().setOpen(KEY, true)
    expect(activeTabOf(useWorkbenchStore.getState(), KEY)).toBe('browser')
  })

  it('a conversation with no memory opens on 工作区 (the old default lives on as the fallback)', () => {
    useWorkbenchStore.getState().setOpen(KEY, true)
    expect(activeTabOf(useWorkbenchStore.getState(), KEY)).toBe('workspace')
  })

  it('auto-open funnels still override with their own tab', () => {
    // 计划/浏览器的自动打开各带各的 tab（文件预览的自动打开也落在工作区），
    // 手动默认不得粘住它们。
    useWorkbenchStore.getState().openTab(KEY, 'workspace')
    useWorkbenchStore.getState().openTab(KEY, 'plan')
    expect(activeTabOf(useWorkbenchStore.getState(), KEY)).toBe('plan')
  })
})

const REPO = process.cwd()
const APP_LAYOUT = join(REPO, 'src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx')

describe('标题栏开关接线 (AppLayout)', () => {
  const src = readFileSync(APP_LAYOUT, 'utf-8')

  it('the toggle exists (non-vacuity)', () => {
    expect(src).toContain('header-pane-btn')
  })

  it('the open branch only re-opens (setOpen): the conversation remembers its own tab', () => {
    // 2026-11-12：开臂不再点名 'workspace'——重开恢复该会话记住的 tab，
    // 无记忆回落 workspace（fallback 在 store 读法里）。
    expect(src).toContain('setOpen(wbKey, true)')
    expect(src).not.toContain("openTab(wbKey, 'workspace')")
    // Non-vacuity: the tab-less toggle form must be gone, not merely accompanied.
    expect(src).not.toContain('setOpen(wbKey, !workbenchOpen)')
  })

  it('the close branch still folds without touching the tab', () => {
    expect(src).toContain('setOpen(wbKey, false)')
  })
})
