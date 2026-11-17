/**
 * 「在系统中打开所在文件夹」（2026-11-15 用户裁定：预览 ⋯ 菜单）。
 *
 * 预览动作菜单的两端（工作台地址栏 ⋯ 与沉浸页签条 ⋯）共用
 * usePreviewFileActions 一份构造器（workspace-file-tabs.test.ts 钉过），
 * 新动作落进它即两端同享，语义不得分叉。通道走新的 SHELL_REVEAL_ITEM
 * （shell.showItemInFolder —— 定位并选中，不接管文件）而不是复用
 * SHELL_OPEN_FOLDER（openPath 会把文件交给默认应用）；安全面刻意不同：
 * reveal 绝不启动目标，safeOpenPath 的可执行黑名单不适用，只留形态校验。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'
import { safeRevealPath } from '../src/main/utils/external-url'

const root = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

const PRELOAD = 'src/preload/index.ts'
const BRIDGE = 'src/shared/types/electron-bridge.ts'
const HANDLER = 'src/main/ipc/app.handler.ts'
const ACTIONS = 'src/renderer/src/components/workbench/preview-file-actions.tsx'
const BAR = 'src/renderer/src/components/workbench/WorkspaceAddressBar.tsx'
const STRIP = 'src/renderer/src/components/workbench/WorkspaceTabStrip.tsx'

describe('safeRevealPath：reveal 专用的形态校验（纯函数直测）', () => {
  it('合法路径原样返回', () => {
    expect(safeRevealPath('/tmp/report.docx')).toBe('/tmp/report.docx')
    expect(safeRevealPath('/tmp/tool.app')).toBe('/tmp/tool.app')
    expect(safeRevealPath('C:\\tmp\\tool.exe')).toBe('C:\\tmp\\tool.exe')
  })

  it('空串/非 trim/内嵌 NUL 拒绝', () => {
    expect(safeRevealPath('')).toBeNull()
    expect(safeRevealPath('   ')).toBeNull()
    expect(safeRevealPath('/tmp/a\0b')).toBeNull()
  })

  it('没有 safeOpenPath 的可执行黑名单——reveal 不启动目标，.app/.exe 只是被 Finder 选中', () => {
    const source = src('src/main/utils/external-url.ts')
    // 只扫函数体（首个 `}` 即函数收口）：doc 注释里的「黑名单缺席」说明
    // 与下方 safeExternalUrl 的黑名单使用都不在扫描范围。
    const fn = source.slice(source.indexOf('export function safeRevealPath'), source.indexOf('}', source.indexOf('export function safeRevealPath')))
    expect(fn).not.toContain('FILE_EXEC_DENY_EXTS')
  })
})

describe('IPC 三层接线', () => {
  it('channel + preload + bridge 类型同在', () => {
    expect(IPC_CHANNELS.SHELL_REVEAL_ITEM).toBe('shell:reveal-item')
    const preload = src(PRELOAD)
    expect(preload).toContain('revealItem: (itemPath: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SHELL_REVEAL_ITEM, itemPath)')
    expect(src(BRIDGE)).toContain('revealItem: (itemPath: string) => Promise<void>')
  })

  it('main handler：safeRevealPath 门 + stat 门 + showItemInFolder，不走可执行黑名单', () => {
    const handler = src(HANDLER)
    expect(handler).toContain('IPC_CHANNELS.SHELL_REVEAL_ITEM')
    // 扫描只框住本 handler（到下一个注册行为止；带上 IPC_CHANNELS. 前缀，
    // 不吃进上方 SHELL_OPEN_FOLDER 注释里的「同门」字样）。
    const block = handler.slice(handler.indexOf('SHELL_REVEAL_ITEM'), handler.indexOf('IPC_CHANNELS.SHELL_OPEN_EXTERNAL'))
    expect(block).toContain('safeRevealPath(itemPath)')
    // stat 门承重：showItemInFolder 对缺失路径是全平台静默 no-op，点击已删除
    // 的文件必须给出可行动报错（openPath 的同一纪律：静默失败 = 点了没按到）。
    expect(block).toContain('await stat(safe)')
    expect(block).toContain('shell.showItemInFolder(safe)')
    expect(block).toContain('文件不存在或已被移动')
    // reveal 绝不启动目标，安全语义与 openPath 分家。
    expect(block).not.toContain('safeOpenPath')
  })
})

describe('预览 ⋯ 菜单（共享构造器，两端同享）', () => {
  const actions = src(ACTIONS)

  it('动作本体住在 preview-file-actions：键/图标/文案/禁用态/点击接线', () => {
    expect(actions).toContain("key: 'revealInFolder'")
    expect(actions).toContain("t('previewPane.revealInFolder')")
    expect(actions).toContain('disabled: !activePath')
    expect(actions).toContain('revealItem(activePath)')
    // 失败 toast 落 err.message（主进程 stat 门的话术），非 Error 回落有兜底文案。
    expect(actions).toMatch(/revealItem\(activePath\)\.catch/)
    expect(actions).toContain("t('previewPane.openInOsFailed')")
  })

  it('divider 分隔：定位是文件系统动作，不混进编辑簇', () => {
    const tail = actions.slice(actions.indexOf("key: 'refresh'"))
    expect(tail.indexOf("{ type: 'divider' as const }")).toBeGreaterThan(-1)
    expect(tail.indexOf("key: 'revealInFolder'")).toBeGreaterThan(tail.indexOf("{ type: 'divider' as const }"))
  })

  it('两端 ⋯ 都仍从共享构造器取动作（防分叉回潮）', () => {
    expect(src(BAR)).toContain('usePreviewFileActions(conversationId)')
    expect(src(STRIP)).toContain('usePreviewFileActions(conversationId)')
  })
})

describe('i18n 两 locale 同步', () => {
  it('revealInFolder 与失败兜底文案在 zh/en 同键', () => {
    const zh = src('src/renderer/src/i18n/locales/zh.ts')
    const en = src('src/renderer/src/i18n/locales/en.ts')
    expect(zh).toContain("revealInFolder: '在系统中打开所在文件夹'")
    expect(en).toContain("revealInFolder: 'Open Containing Folder'")
    expect(zh).toContain("openInOsFailed: '无法在系统中打开'")
    expect(en).toContain("openInOsFailed: 'Could not open in system'")
  })
})
