// ── Secondary-window boot flags (PLAN-conversation-popout 2026-10-30;
//    project windows 2026-10-30) ──
// The one place that decides WHICH renderer process this is — parsed from the
// window's query param (main.tsx, before any component mounts) and consumed by
// the few bindings that must behave differently in a secondary window. There
// is no other per-window mode detection in the app: this module is the
// precedent.
//
// Consumers:
//   • main.tsx  — render PopoutApp (conversation popout OR project window)
//     instead of the full workbench App
//   • useBrowserPane — never push browser pane state (the native
//     WebContentsView dock is a main-window singleton, appViewDock; a
//     secondary window must not become its target, or the native view would
//     composite over the wrong window)
//
// Both kinds boot the SAME root component (PopoutApp): a project window is the
// popout bound to a project instead of a fixed conversation. Kept as two
// separate parsers rather than one 「window mode」 union so the popout flag the
// existing pins and probes read stays byte-identical.
let parsed: { convId: string } | null | undefined
let parsedProject: { projectId: string } | null | undefined

export function parsePopoutParam(): { convId: string } | null {
  if (parsed !== undefined) return parsed
  try {
    const id = new URLSearchParams(window.location.search).get('popout')
    parsed = id ? { convId: id } : null
  } catch {
    parsed = null
  }
  return parsed
}

/** `?project=<projectId>` — the immersive project window. */
export function parseProjectParam(): { projectId: string } | null {
  if (parsedProject !== undefined) return parsedProject
  try {
    const id = new URLSearchParams(window.location.search).get('project')
    parsedProject = id ? { projectId: id } : null
  } catch {
    parsedProject = null
  }
  return parsedProject
}

export const IS_POPOUT = parsePopoutParam() !== null
export const IS_PROJECT_WINDOW = parseProjectParam() !== null
