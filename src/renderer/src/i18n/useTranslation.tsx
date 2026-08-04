import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { DEFAULT_LOCALE, getDict, t as translate } from './index'
import type { Locale, TranslationDict } from './index'

interface TranslationContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (path: string, values?: Record<string, string | number>) => string
}

const TranslationContext = createContext<TranslationContextValue | null>(null)

export function TranslationProvider({
  children,
  initialLocale = DEFAULT_LOCALE
}: {
  children: React.ReactNode
  initialLocale?: Locale
}): React.ReactElement {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  const dictRef = useRef<TranslationDict>(getDict(initialLocale))

  const setLocale = useCallback((next: Locale) => {
    if (next === locale && dictRef.current === getDict(next)) return
    setLocaleState(next)
    dictRef.current = getDict(next)
  }, [locale])

  const tFn = useCallback((path: string, values?: Record<string, string | number>) => {
    return translate(dictRef.current, path, values)
  }, [])

  const value = useMemo<TranslationContextValue>(
    () => ({ locale, setLocale, t: tFn }),
    [locale, setLocale, tFn]
  )

  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  )
}

export function useTranslation(): TranslationContextValue {
  const ctx = useContext(TranslationContext)
  if (!ctx) {
    throw new Error('useTranslation must be used within a TranslationProvider')
  }
  return ctx
}
