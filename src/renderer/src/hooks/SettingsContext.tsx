import React, { createContext, useContext } from 'react'
import { useAppSettings } from './useAppSettings'
import type { UseAppSettingsReturn } from './useAppSettings'

const SettingsContext = createContext<UseAppSettingsReturn | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const settings = useAppSettings()
  return (
    <SettingsContext.Provider value={settings}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): UseAppSettingsReturn {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return ctx
}
