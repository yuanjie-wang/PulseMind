// DOM side of the palette (PLAN-dark-mode M1): the injected variable sheet, the
// html[data-theme] attribute and the localStorage mirror. Every function guards
// on `typeof document` so the node-env vitest suite can import this module
// without a DOM; the browser-only behaviour is exercised by the probes.
import {
  buildThemeCss,
  resolveThemePreference,
  type ThemeMode,
  type ThemePreference,
} from './palette'

const STYLE_ID = 'pm-theme-vars'
// The mirror carries the preference across the async settings load: main.tsx
// applies it before React mounts, so a dark session never paints a light first
// frame while settings.json travels over IPC. Written on every apply, read once
// at mount (and once in main.tsx).
const MIRROR_KEY = 'pm.theme'

export function installThemeVars(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = buildThemeCss()
  document.head.appendChild(el)
}

export function applyThemeAttr(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = mode
}

export function readThemeMirror(): ThemePreference | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const v = localStorage.getItem(MIRROR_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : null
  } catch {
    return null
  }
}

export function writeThemeMirror(pref: ThemePreference): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(MIRROR_KEY, pref)
  } catch {
    // Private-mode quota errors etc. — the mirror is an optimization, not state.
  }
}

/** Resolve + apply in one call. main.tsx uses this for the pre-React paint. */
export function applyThemePreference(pref: ThemePreference, systemDark: boolean): void {
  applyThemeAttr(resolveThemePreference(pref, systemDark))
}
