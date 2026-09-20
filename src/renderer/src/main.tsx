import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyThemePreference, installThemeVars, readThemeMirror } from './theme/dom'
import { setThemeMode } from './theme/mode'
import { resolveThemePreference } from './theme/palette'

// Theme before React: the CSS variable sheet must exist for the first paint,
// and a dark session must not flash light while settings load over IPC — the
// mirror (written on every apply in AppContent) carries the previous session's
// preference. The mode store is primed from the same resolution so the first
// render already picks the dark markdown class and the dark Prism style;
// AppContent re-applies both with the real settings once they arrive.
installThemeVars()
const bootThemePref = readThemeMirror()
if (bootThemePref) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  applyThemePreference(bootThemePref, systemDark)
  setThemeMode(resolveThemePreference(bootThemePref, systemDark))
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
