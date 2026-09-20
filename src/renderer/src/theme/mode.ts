// The resolved theme mode, readable from anywhere (PLAN-dark-mode M2).
//
// `html[data-theme]` flips every `var(--pm-*)` surface on its own, so most
// components never need this module. Two kinds of consumer do: things that
// switch a *class name* (the markdown theme families — `.x-markdown-light` /
// `.x-markdown-dark` are disjoint selector sets, not variables), and things
// whose colours are a JS object rather than CSS (Prism's oneLight/oneDark in
// CodeHighlight). Both read the mode through `useThemeMode()`, so a switch
// re-renders exactly the components that cannot be reached by CSS.
//
// The value is written by AppContent (which owns the settings + matchMedia
// resolution) and by main.tsx before React mounts, so the first paint already
// carries the right mode. Module state, not context: `getThemeMode()` is
// callable outside the tree, and node-env vitest can import this file as-is.
import { useSyncExternalStore } from 'react'
import type { ThemeMode } from './palette'

let mode: ThemeMode = 'light'
const listeners = new Set<() => void>()

export function getThemeMode(): ThemeMode {
  return mode
}

/** The same-value short circuit is load-bearing: a system-mode matchMedia
 *  event that resolves to the mode already in force must not notify, or every
 *  subscriber (and antd's cssinjs behind it) recomputes for nothing. */
export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return
  mode = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, getThemeMode)
}

/** The markdown theme class for the current mode — the value every XMarkdown
 *  wrapper puts on its container (the two theme files are loaded together in
 *  App.tsx; only the class decides which one applies). */
export function markdownThemeClass(): string {
  return mode === 'dark' ? 'x-markdown-dark' : 'x-markdown-light'
}

/** markdownThemeClass() for components: re-renders the caller on a switch. */
export function useMarkdownThemeClass(): string {
  return useThemeMode() === 'dark' ? 'x-markdown-dark' : 'x-markdown-light'
}
