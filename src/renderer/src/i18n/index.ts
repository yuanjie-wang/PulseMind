import zhDict from './locales/zh'
import enDict from './locales/en'

export type Locale = 'zh' | 'en'

export const SUPPORTED_LOCALES: Locale[] = ['zh', 'en']
export const DEFAULT_LOCALE: Locale = 'zh'

export type TranslationDict = typeof zhDict

const dictMap: Record<Locale, TranslationDict> = {
  zh: zhDict,
  en: enDict
}

export function getDict(locale: Locale): TranslationDict {
  return dictMap[locale]
}

/**
 * Look up a translation by dot-separated path (e.g. "welcome.title").
 * Supports {{var}} interpolation for dynamic values.
 * Returns the key path as fallback if missing (visible in UI for debugging).
 */
export function t(
  dict: TranslationDict,
  path: string,
  values?: Record<string, string | number>
): string {
  const keys = path.split('.')
  let result: unknown = dict
  for (const key of keys) {
    if (result == null || typeof result !== 'object') {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[i18n] Missing translation key: "${path}"`)
      }
      return path
    }
    result = (result as Record<string, unknown>)[key]
  }
  if (typeof result !== 'string') {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[i18n] Translation key "${path}" is not a string, got: ${typeof result}`)
    }
    return path
  }

  if (values) {
    return Object.entries(values).reduce(
      (str, [key, val]) => str.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val)),
      result
    )
  }

  return result
}
