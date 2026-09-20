// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import { App, ConfigProvider } from 'antd'
import SettingsPage from '../src/renderer/src/components/settings/SettingsPage'
import { SettingsProvider } from '../src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from '../src/renderer/src/i18n/useTranslation'

vi.mock('../src/renderer/src/components/settings/EnvironmentSettings', () => ({ default: () => React.createElement('div', null, 'Environment fixture') }))

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

const initial = {
  activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '/fixture/workspace',
  launchAtLogin: false, autoCleanup: false, conversationRetentionDays: 0,
  routineRunRetentionDays: 0, git: { contextInjection: true },
}

async function mountSettingsPage(
  container: HTMLElement,
  save: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof createRoot>> {
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  window.electronAPI = new Proxy({}, { get: (_, key) => {
    if (key in overrides) return overrides[key as string]
    if (String(key).startsWith('on')) return () => () => {}
    if (key === 'getSettings') return async () => initial
    if (key === 'setSettings') return save
    if (key === 'getDataPaths') return async () => ({ dataDir: '/fixture/data', knowledgeDir: '/fixture/knowledge', workspaceDir: '/fixture/workspace' })
    return async () => []
  } }) as typeof window.electronAPI
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConfigProvider, null, React.createElement(App, null, React.createElement(SettingsProvider, null, React.createElement(TranslationProvider, { initialLocale: 'zh' }, React.createElement(SettingsPage))))))
    await flush()
  })
  return root
}

async function openTab(container: HTMLElement, label: string): Promise<void> {
  const entry = [...container.querySelectorAll('span')].find((el) => el.textContent === label)
  expect(entry, label).toBeDefined()
  await act(async () => { entry!.click(); await flush() })
}

describe('SettingsPage data and runtime integration', () => {
  it('navigates to data settings and persists only the auto-start change', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const save = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await mountSettingsPage(container, save)
    try {
      await openTab(container, '数据与运行')
      const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="开机自启"]')
      expect(toggle).not.toBeNull()
      expect(toggle!.disabled).toBe(false)
      expect(toggle!.getAttribute('aria-checked')).toBe('false')
      await act(async () => { toggle!.click(); await flush() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith({ ...initial, launchAtLogin: true })
      expect(toggle!.getAttribute('aria-checked')).toBe('true')
      // The directory rows moved to 环境设置 — the data tab renders none.
      expect(container.querySelector('[data-directory="workspaceDir"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })

  it('navigates to the browser-extension tab and renders the service toggle', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const save = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await mountSettingsPage(container, save)
    try {
      await openTab(container, '浏览器插件')
      const toggle = container.querySelector<HTMLButtonElement>('[data-extension-toggle]')
      expect(toggle).not.toBeNull()
      // The electronAPI proxy answers serviceGetStatus with `[]`, so the
      // component reads enabled=false — the toggle renders off, not crashed.
      expect(toggle!.getAttribute('aria-checked')).toBe('false')
      expect(container.querySelector('[data-extension-export]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })

  // The 2026-09-20 report: 启用插件连接服务的开关点击后按钮无变化 + 已连接的
  // 客户端信息不准确. Root cause was main-side (the ws handle had no
  // clients(), so SERVICE_GET_STATUS threw whenever the service ran — see the
  // ws-server scans in extension-settings-wiring.test.ts). This test pins the
  // renderer contract the report exercised: a click flips the toggle and the
  // refreshed status lists the client.
  it('the extension service toggle flips on and the connected client shows', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const save = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    // A fake service with a REAL status payload: off at first, on after the
    // toggle — the exact shape serviceGetStatus returns now that the handle
    // carries clients().
    let service: { enabled: boolean; running: boolean } = { enabled: false, running: false }
    const overrides = {
      serviceGetStatus: async () => ({
        enabled: service.enabled,
        port: 8765,
        running: service.running,
        token: 'tok',
        clients: service.running ? [{ clientId: 'pulsemind-extension', sessions: 2 }] : [],
        wsUrl: 'ws://127.0.0.1:8765',
        extensionDir: null,
      }),
      serviceSetEnabled: async (enabled: boolean) => {
        service = { enabled, running: enabled }
        return { running: enabled, port: 8765 }
      },
      openExternal: vi.fn(async () => undefined),
    }
    const root = await mountSettingsPage(container, save, overrides)
    try {
      await openTab(container, '浏览器插件')
      const toggle = container.querySelector<HTMLButtonElement>('[data-extension-toggle]')
      expect(toggle).not.toBeNull()
      expect(toggle!.getAttribute('aria-checked')).toBe('false')
      // The clients row renders only once a client is actually connected
      // (data-extension-clients is the component's own hook for it).
      expect(container.querySelector('[data-extension-clients]')).toBeNull()

      await act(async () => { toggle!.click(); await flush() })

      // The click survives the status refresh — the toggle does not spring back.
      expect(toggle!.getAttribute('aria-checked')).toBe('true')
      // The success toast rides antd's static sink (document.body) in this
      // harness — give its render a few macrotasks.
      for (let i = 0; i < 20 && !(document.body.textContent ?? '').includes('服务已启动'); i++) await new Promise((r) => setTimeout(r, 10))
      expect(document.body.textContent).toContain('服务已启动')
      const clientsRow = container.querySelector('[data-extension-clients]')
      expect(clientsRow).not.toBeNull()
      expect(clientsRow!.textContent).toContain('pulsemind-extension')
      expect(clientsRow!.textContent).toContain('2')
      // 连接信息 answers now that the service reports running — the port rides
      // an antd Input's value attribute, not textContent.
      const portInput = [...container.querySelectorAll('input')].find((i) => i.value === '8765')
      expect(portInput).toBeDefined()

      // The guide names chrome://extensions as a real link, wired to
      // openExternal (期望可直接点击).
      const guideLink = [...container.querySelectorAll('a')].find((a) => a.textContent === 'chrome://extensions')
      expect(guideLink).toBeDefined()
      await act(async () => { guideLink!.click(); await flush() })
      expect(overrides.openExternal).toHaveBeenCalledWith('chrome://extensions')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })

  it('navigates to the shortcuts tab, records a chord and persists the override', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const save = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await mountSettingsPage(container, save)
    try {
      await openTab(container, '快捷键')
      // jsdom's navigator.platform is blank → not mac → defaults render Ctrl+N.
      const key = container.querySelector<HTMLElement>('[data-shortcut-key="new-task"]')
      expect(key?.textContent).toBe('Ctrl+N')

      const edit = container.querySelector<HTMLButtonElement>('[data-shortcut-edit="open-usage"]')
      expect(edit).not.toBeNull()
      await act(async () => { edit!.click(); await flush() })
      expect(container.querySelector('[data-shortcut-recording="open-usage"]')).not.toBeNull()

      // A real chord through the capture listener: Ctrl+U → CmdOrCtrl+U.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'U', ctrlKey: true, bubbles: true }))
        await flush()
      })
      expect(save).toHaveBeenCalledWith({ ...initial, shortcuts: { 'open-usage': 'CmdOrCtrl+U' } })
      expect(container.querySelector('[data-shortcut-recording="open-usage"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })
})
