// The theme preference contract, shared by the renderer and the main process
// (PLAN-dark-mode M1). The user picks light / dark / system; each side resolves
// `system` against its own OS source — the renderer against
// prefers-color-scheme, main against nativeTheme.shouldUseDarkColors. Pure
// logic on purpose: it is imported from both processes and the vitest suite.

export type ThemeMode = 'light' | 'dark'
export type ThemePreference = ThemeMode | 'system'

/** Resolve a preference to a concrete mode. `pref` is typed loose because
 *  settings.json on disk is untrusted; anything unknown reads as light. */
export function resolveThemePreference(pref: string | undefined, systemDark: boolean): ThemeMode {
  if (pref === 'dark') return 'dark'
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return 'light'
}
