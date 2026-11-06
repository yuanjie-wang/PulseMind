import { useState, useEffect, useCallback } from 'react'
import type { AppSettings, LlmProfile, LlmProviderConfig } from '../types/settings'

const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: '',
  providers: [],
  profiles: [],
  // Renderer-side default shown only while settings load over IPC (the real
  // default lives in main's settings-store, also 'light'; the theme mirror in
  // theme/dom.ts carries the previous session's choice across this window).
  theme: 'light',
  myName: '',
  soul: '',
  yourName: '',
  workspaceDir: '',
  autoCleanup: false,
  locale: 'zh',
  maxLoopIterations: 200,
  maxParallelSubAgents: 5
}

export interface UseAppSettingsReturn {
  settings: AppSettings
  loading: boolean
  saving: boolean
  hasApiKey: boolean
  saveSettings: (s: AppSettings) => Promise<void>
  reloadSettings: () => Promise<void>
  // Profile management (两层模型配置：供应商 → 模型)
  activeProfile: LlmProfile | undefined
  /** Switch the DEFAULT model (`settings.activeProfileId` = a model entry id).
   *  New conversations and conversations without their own choice follow it. */
  switchProfile: (profileId: string) => Promise<void>
  /** Persist a whole providers draft (the settings editor's two-layer edit).
   *  `activeProfileId` rides the same write when 使用此模型 was pressed. The
   *  derived `profiles` are re-derived main-side; a reload pulls the fresh
   *  merged views back into this context. */
  saveModelConfig: (providers: LlmProviderConfig[], activeProfileId?: string) => Promise<void>
}

export function useAppSettings(): UseAppSettingsReturn {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const s = await window.electronAPI.getSettings()
        setSettings(s)
      } catch (err) {
        console.error('Failed to load settings:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Cross-window sync: any window's save is broadcast to all windows by the
  // main process (settings:changed). Adopt the store's view so surfaces the
  // popout derives from settings — theme, locale — follow the main window
  // immediately instead of waiting for a reload. The saver's own window gets
  // the same (idempotent) payload; no write is triggered, so no loop.
  useEffect(() => {
    const unsub = window.electronAPI?.onSettingsChanged?.((next) => {
      setSettings(next)
    })
    return unsub
  }, [])

  // settings.profiles is the store's MERGED view (one entry per model,
  // connection fields materialized from its provider) — the credentials the
  // welcome composer and MCP summaries read live here. `?? []` keeps fixtures
  // / pre-hydration snapshots from crashing on a missing key.
  const activeProfile = (settings.profiles ?? []).find(
    (p) => p.id === settings.activeProfileId
  )

  // API key is stored on the provider (settings.json) and materialized onto
  // the merged profile view, so it stays in sync automatically.
  const hasApiKey = !!activeProfile?.apiKey

  const saveSettings = useCallback(async (s: AppSettings) => {
    setSaving(true)
    try {
      await window.electronAPI.setSettings(s)
      setSettings(s)
    } catch (err) {
      console.error('Failed to save settings:', err)
      throw err
    } finally {
      setSaving(false)
    }
  }, [])

  const reloadSettings = useCallback(async () => {
    try {
      const s = await window.electronAPI.getSettings()
      setSettings(s)
    } catch (err) {
      console.error('Failed to reload settings:', err)
    }
  }, [])

  const persistAndUpdate = useCallback(
    async (updated: AppSettings) => {
      setSaving(true)
      try {
        await window.electronAPI.setSettings(updated)
        setSettings(updated)
      } catch (err) {
        console.error('Failed to save settings:', err)
        throw err
      } finally {
        setSaving(false)
      }
    },
    []
  )

  // --- Model config (供应商 → 模型 两层) ---

  const switchProfile = useCallback(
    async (profileId: string) => {
      if (profileId === settings.activeProfileId) return
      const oldId = settings.activeProfileId
      const updated = { ...settings, activeProfileId: profileId }
      console.log(`[useAppSettings] switchProfile: ${oldId} -> ${profileId}`)
      await persistAndUpdate(updated)
    },
    [settings, persistAndUpdate]
  )

  const saveModelConfig = useCallback(
    async (providers: LlmProviderConfig[], activeProfileId?: string) => {
      setSaving(true)
      try {
        const payload: AppSettings = {
          ...settings,
          providers,
          ...(activeProfileId ? { activeProfileId } : {})
        }
        await window.electronAPI.setSettings(payload)
        // The merged profile views were re-derived main-side — pull them back
        // instead of trusting this snapshot's stale copies (the welcome
        // composer reads activeProfile right after a save).
        const fresh = await window.electronAPI.getSettings()
        setSettings(fresh)
      } catch (err) {
        console.error('Failed to save model config:', err)
        throw err
      } finally {
        setSaving(false)
      }
    },
    [settings]
  )

  return {
    settings,
    loading,
    saving,
    hasApiKey,
    saveSettings,
    reloadSettings,
    // Profile management
    activeProfile,
    switchProfile,
    saveModelConfig
  }
}
