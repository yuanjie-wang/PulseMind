// 菜单 / 加速键 / 命令面板 / notify 桥 / Tab 恢复的接线扫描。
// vitest 是 node-env，挂不起 Electron 与 AppLayout —— 与 pending-approval /
// conversation-key 的做法一致：对源码做带断言数量的扫描，任何一跳断了
// （方法改名、case 丢失、桥面漏声明、订阅没人消费）都会在这里红。
// 非空验证由三份 guard 保证：文件读不到就抛、每个扫描都数命中数、
// 「删除的东西不再出现」用负断言钉住。

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
function read(rel: string): string {
  const p = join(ROOT, rel)
  expect(existsSync(p), `${rel} 不存在`).toBe(true)
  return readFileSync(p, 'utf8')
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const ACTIONS = ['new-task', 'new-project', 'command-palette', 'toggle-sidebar', 'toggle-workbench', 'open-search', 'open-settings', 'open-usage']

describe('main 菜单（src/main/menu.ts）', () => {
  const src = read('src/main/menu.ts')

  it('真的安装了应用菜单（此前全仓库无一处 setApplicationMenu）', () => {
    expect(count(src, 'Menu.setApplicationMenu')).toBeGreaterThanOrEqual(1)
  })

  it('八个动作全部有菜单项；全部动作常量与分发一一出现', () => {
    for (const action of ACTIONS) {
      expect(count(src, `'${action}'`)).toBeGreaterThanOrEqual(1)
    }
  })

  it('Edit 菜单带 role 的 copy/paste —— 只读区域复制靠它', () => {
    expect(src).toContain("{ role: 'copy' }")
    expect(src).toContain("{ role: 'paste' }")
  })

  it('非 mac 走 before-input-event fallback 且只在非 darwin 挂载（mac 菜单加速器会双触发）', () => {
    const fallback = src.slice(src.indexOf('export function attachShortcutFallback'))
    expect(fallback).toContain('before-input-event')
    expect(fallback).toContain("process.platform === 'darwin'")
    // fallback 的组合键不再硬编码 —— 由生效加速器表派生（默认 + 设置覆盖），
    // 设置 → 快捷键 改键后在 Win/Linux 同样立即生效。
    // 非空验证：删掉 refreshFallbackCombos 的调用或改回硬编码表都会红。
    expect(src).toContain('refreshFallbackCombos(accelerators)')
    expect(src).toContain('effectiveAccelerators(stored?.shortcuts)')
    expect(src).not.toContain("'ctrl+k'")
  })

  it('菜单标签本地 zh/en 各一份，经 settingsStore 的 locale 选择', () => {
    expect(src).toContain('settingsStore.get()')
    expect(src).toContain("'zh' | 'en'")
  })
})

describe('启动与设置的接线', () => {
  it('index.ts 在启动时装菜单、在 createWindow 里挂 fallback（托盘重建窗口也覆盖）', () => {
    const src = read('src/main/index.ts')
    expect(src).toContain('installApplicationMenu')
    expect(src.indexOf('installApplicationMenu')).toBeGreaterThan(-1)
    // attach 必须在 createWindow 体内而不是启动一次 —— 窗口会被重建
    const createWindow = src.slice(src.indexOf('function createWindow()'), src.indexOf('if (gotTheLock)'))
    expect(createWindow).toContain('attachShortcutFallback(mainWindow)')
  })

  it('settings.handler 在保存后重建菜单（语言切换立即生效）', () => {
    const src = read('src/main/ipc/settings.handler.ts')
    expect(src).toContain('rebuildApplicationMenu')
  })
})

describe('preload 与桥面契约', () => {
  it('preload 暴露 onMenuAction 并挂在 MENU_ACTION 通道上', () => {
    const src = read('src/preload/index.ts')
    expect(src).toContain('onMenuAction')
    expect(src).toContain('IPC_CHANNELS.MENU_ACTION')
  })

  it('bridge 类型声明 onMenuAction + testLlmConnection（三层契约的单一定义点）', () => {
    const src = read('src/shared/types/electron-bridge.ts')
    expect(src).toContain('onMenuAction: (callback: (action: string) => void) => () => void')
    expect(src).toContain('testLlmConnection')
  })

  it('llm:test-connection 通道有 handler 注册', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("LLM_TEST_CONNECTION: 'llm:test-connection'")
    expect(read('src/main/ipc/llm-probe.handler.ts')).toContain('IPC_CHANNELS.LLM_TEST_CONNECTION')
    expect(read('src/main/ipc/index.ts')).toContain('registerLlmProbeHandlers')
  })

  it('连通性探测复用 api-proxy 的头部合并与 SSRF 校验（同一条路径）', () => {
    const proxy = read('src/main/ipc/api-proxy.handler.ts')
    expect(proxy).toContain('export async function applyProfileHeaders')
    expect(proxy).toContain('export async function validateRequestUrl')
    const probe = read('src/main/services/llm-probe.ts')
    expect(probe).toContain("from '../ipc/api-proxy.handler'")
  })
})

describe('渲染层消费（AppLayout / App）', () => {
  it('AppLayout 订阅 onMenuAction，八个动作各有 case，命令面板经 store 打开', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(src).toContain('onMenuAction')
    for (const action of ACTIONS) {
      expect(src).toContain(`case '${action}'`)
    }
    expect(src).toContain('useCommandPaletteStore')
    expect(src).toContain('<CommandPalette items={paletteItems} />')
  })

  it('订阅只挂一次、经 ref 分发（不能每个 streamed token 重订阅）', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(src).toContain('menuActionRef')
    // 订阅 effect 必须是空依赖数组
    const effect = src.slice(src.indexOf('window.electronAPI?.onMenuAction'))
    expect(effect.slice(0, effect.indexOf('})') + 2)).toContain('}, [])')
  })

  it('App.tsx：Tab 全局禁用已删除、NotifyBridge 已挂进 AntdApp', () => {
    const src = read('src/renderer/src/App.tsx')
    expect(src).not.toContain('Disable Tab key focus navigation')
    expect(src).not.toContain("e.key === 'Tab'")
    expect(src).toContain('<NotifyBridge />')
    // 三处静默失败改为留痕
    expect(src).toContain("reportSilentFailure('mcp-summary'")
    expect(src).toContain("reportSilentFailure('memory-compress'")
    expect(src).toContain("reportSilentFailure('memory-migrate'")
    expect(count(src, 'catch(() => {})')).toBe(0)
  })

  it('AppLayout 样式块：:focus:not(:focus-visible) 规则存在，旧 :focus-visible 压制已替换', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(src).toContain(':focus:not(:focus-visible)')
    expect(src).not.toContain('.ant-switch:focus-visible')
  })
})

describe('命令面板纯逻辑文件', () => {
  it('items/过滤在 navigation 下、组件在 layout 下、store 独立', () => {
    expect(existsSync(join(ROOT, 'src/renderer/src/navigation/command-palette-items.ts'))).toBe(true)
    expect(existsSync(join(ROOT, 'src/renderer/src/components/layout/CommandPalette.tsx'))).toBe(true)
    expect(existsSync(join(ROOT, 'src/renderer/src/stores/commandPaletteStore.ts'))).toBe(true)
  })
})
