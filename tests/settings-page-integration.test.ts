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

describe('SettingsPage data and runtime integration', () => {
  it('navigates to data settings and persists only the auto-start change', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
    const initial = {
      activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '/fixture/workspace',
      launchAtLogin: false, autoCleanup: false, conversationRetentionDays: 0,
      routineRunRetentionDays: 0, git: { contextInjection: true },
    }
    const save = vi.fn().mockResolvedValue(undefined)
    window.electronAPI = new Proxy({}, { get: (_, key) => {
      if (String(key).startsWith('on')) return () => () => {}
      if (key === 'getSettings') return async () => initial
      if (key === 'setSettings') return save
      if (key === 'getDataPaths') return async () => ({ dataDir: '/fixture/data', knowledgeDir: '/fixture/knowledge', workspaceDir: '/fixture/workspace' })
      return async () => []
    } }) as typeof window.electronAPI
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(ConfigProvider, null, React.createElement(App, null, React.createElement(SettingsProvider, null, React.createElement(TranslationProvider, { initialLocale: 'zh' }, React.createElement(SettingsPage))))))
        await flush()
      })
      const entry = [...container.querySelectorAll('span')].find(el => el.textContent === '数据与运行')
      expect(entry).toBeDefined()
      await act(async () => { entry!.click(); await flush() })
      const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="开机自启"]')
      expect(toggle).not.toBeNull()
      expect(toggle!.disabled).toBe(false)
      expect(toggle!.getAttribute('aria-checked')).toBe('false')
      await act(async () => { toggle!.click(); await flush() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith({ ...initial, launchAtLogin: true })
      expect(toggle!.getAttribute('aria-checked')).toBe('true')
      expect(container.querySelector('[data-directory="workspaceDir"]')?.textContent).toBe('/fixture/workspace')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })
})
