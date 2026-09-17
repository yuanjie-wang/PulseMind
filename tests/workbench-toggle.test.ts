// ── 手动打开工作台，默认落在「工作区」tab ──
// 用户要求（2026-09-17）：主动打开侧边窗口时默认选择工作区 tab。此前标题栏
// 的开关只是 `setOpen(key, !open)`，打开后显示的是上次持久化的 activeTab
// （全新安装是「文件预览」），与用户预期不符。
//
// 两条腿，互不覆盖（vitest 是 node 环境，组件挂不了）：store 的 openTab
// 语义在这里真跑；「按钮的打开分支走的是 openTab 而不是 setOpen」是接线
// 事实，只能扫源码——见 tests/pending-approval.test.ts 的同一手法。

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  useWorkbenchStore,
  WORKBENCH_DEFAULT_WIDTH,
} from '../src/renderer/src/stores/workbenchStore'

const KEY = 'conv_test'

describe('workbenchStore (manual-open contract)', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openByConversation: {},
      width: WORKBENCH_DEFAULT_WIDTH,
      activeTab: 'files',
    })
  })

  it('openTab opens the pane and brings the named tab to the front', () => {
    useWorkbenchStore.getState().openTab(KEY, 'workspace')
    const s = useWorkbenchStore.getState()
    expect(s.openByConversation[KEY]).toBe(true)
    expect(s.activeTab).toBe('workspace')
  })

  it('closing remembers the tab, so only the OPEN branch may pick 工作区', () => {
    useWorkbenchStore.getState().openTab(KEY, 'browser')
    useWorkbenchStore.getState().setOpen(KEY, false)
    // 收起不动 tab：下次打开走哪条路径，看到的就是哪条路径选的 tab。
    expect(useWorkbenchStore.getState().activeTab).toBe('browser')
  })

  it('auto-open funnels still override with their own tab', () => {
    // 计划/浏览器/文件预览的自动打开各带各的 tab，手动默认不得粘住它们。
    useWorkbenchStore.getState().openTab(KEY, 'workspace')
    useWorkbenchStore.getState().openTab(KEY, 'plan')
    expect(useWorkbenchStore.getState().activeTab).toBe('plan')
  })
})

const REPO = process.cwd()
const APP_LAYOUT = join(REPO, 'src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx')

describe('标题栏开关接线 (AppLayout)', () => {
  const src = readFileSync(APP_LAYOUT, 'utf-8')

  it('the toggle exists (non-vacuity)', () => {
    expect(src).toContain('header-pane-btn')
  })

  it('the open branch routes through openTab with 工作区, not the tab-less setOpen', () => {
    expect(src).toContain("openTab(wbKey, 'workspace')")
    // Non-vacuity: the tab-less toggle form must be gone, not merely accompanied.
    expect(src).not.toContain('setOpen(wbKey, !workbenchOpen)')
  })

  it('the close branch still folds without touching the tab', () => {
    expect(src).toContain('setOpen(wbKey, false)')
  })
})
