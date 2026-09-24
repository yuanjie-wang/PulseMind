import { useState, useEffect, useCallback } from 'react'
import type { AppSettings, LlmProfile } from '../types/settings'

const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: '',
  profiles: [],
  // Renderer-side default shown only while settings load over IPC (the real
  // default lives in main's settings-store, also 'dark'; the theme mirror in
  // theme/dom.ts carries the previous session's choice across this window).
  theme: 'dark',
  myName: '',
  soul: '',
  yourName: '',
  workspaceDir: '',
  autoCleanup: false,
  locale: 'zh',
  maxLoopIterations: 50,
  maxParallelSubAgents: 5
}

export interface UseAppSettingsReturn {
  settings: AppSettings
  loading: boolean
  saving: boolean
  hasApiKey: boolean
  saveSettings: (s: AppSettings) => Promise<void>
  reloadSettings: () => Promise<void>
  setApiKey: (key: string) => Promise<void>
  getApiKey: () => Promise<string | null>
  // Profile management
  activeProfile: LlmProfile | undefined
  switchProfile: (profileId: string) => Promise<void>
  addProfile: (profile: LlmProfile) => Promise<void>
  saveProfile: (profileId: string, updates: LlmProfile) => Promise<void>
  deleteProfile: (profileId: string) => Promise<void>
  /** Atomic save profile data + switch to it in a single state update */
  saveAndSwitchProfile: (profileId: string, profile: LlmProfile) => Promise<void>
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

  const activeProfile = settings.profiles.find(
    (p) => p.id === settings.activeProfileId
  )

  // API key is stored directly in the profile (settings.json), not in a
  // separate encrypted file.  Derived here so it stays in sync automatically.
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

  // --- Profile management ---

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

  const addProfile = useCallback(
    async (profile: LlmProfile) => {
      const updated = {
        ...settings,
        profiles: [...settings.profiles, profile]
        // Don't auto-activate — user must click "Use This Profile"
      }
      await persistAndUpdate(updated)
    },
    [settings, persistAndUpdate]
  )

  /**
   * Save profile fields (apiKey is now part of LlmProfile, so it is
   * persisted atomically with the rest of the profile in settings.json).
   */
  const saveProfile = useCallback(
    async (profileId: string, profile: LlmProfile) => {
      console.log(`[useAppSettings] saveProfile: id=${profileId} name="${profile.name}" model=${profile.model}`)
      const updated = {
        ...settings,
        profiles: settings.profiles.map((p) =>
          p.id === profileId ? profile : p
        )
      }
      await persistAndUpdate(updated)
    },
    [settings, persistAndUpdate]
  )

  const deleteProfile = useCallback(
    async (profileId: string) => {
      if (settings.profiles.length <= 1) return // can't delete last profile
      const remaining = settings.profiles.filter((p) => p.id !== profileId)
      const nextId =
        settings.activeProfileId === profileId
          ? remaining[0].id
          : settings.activeProfileId
      const updated = {
        ...settings,
        activeProfileId: nextId,
        profiles: remaining
      }
      await persistAndUpdate(updated)
    },
    [settings, persistAndUpdate]
  )

  /**
   * Atomically save profile data AND switch activeProfileId in a single
   * state update.  This avoids the stale-closure race that occurs when
   * saveProfile and switchProfile are called sequentially (the second call
   * reads stale `settings` from its closure and overwrites the first).
   */
  const saveAndSwitchProfile = useCallback(
    async (profileId: string, profile: LlmProfile) => {
      console.log(`[useAppSettings] saveAndSwitchProfile: id=${profileId} name="${profile.name}" model=${profile.model}`)
      const updated = {
        ...settings,
        activeProfileId: profileId,
        profiles: settings.profiles.map((p) =>
          p.id === profileId ? profile : p
        )
      }
      await persistAndUpdate(updated)
    },
    [settings, persistAndUpdate]
  )

  const setApiKeyFn = useCallback(async (key: string) => {
    if (!activeProfile) return
    const profile = { ...activeProfile, apiKey: key }
    const updated = {
      ...settings,
      profiles: settings.profiles.map((p) =>
        p.id === activeProfile.id ? profile : p
      )
    }
    await persistAndUpdate(updated)
  }, [settings, activeProfile, persistAndUpdate])

  const getApiKey = useCallback(async (): Promise<string | null> => {
    return activeProfile?.apiKey ?? null
  }, [activeProfile])

  return {
    settings,
    loading,
    saving,
    hasApiKey,
    saveSettings,
    reloadSettings,
    setApiKey: setApiKeyFn,
    getApiKey,
    // Profile management
    activeProfile,
    switchProfile,
    addProfile,
    saveProfile,
    deleteProfile,
    saveAndSwitchProfile
  }
}
