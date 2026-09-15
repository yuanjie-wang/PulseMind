/** Tab ↔ session bookkeeping for the extension (PLAN-browser-extension §3.3).
 *
 * One session per tab; the mapping must survive service-worker restarts (MV3
 * kills idle workers) and page navigations, so it lives in chrome.storage.session
 * rather than in module state. Content scripts cannot read session storage
 * directly (Chrome grants it to trusted contexts only), which is why the panel
 * asks the worker instead. */

import { toSandboxApprovalMode, type SandboxApprovalMode } from '../../shared/sandbox/policy'

const KEY_TAB_SESSIONS = 'tabSessions'
const KEY_SESSION_TABS = 'sessionTabs'
const KEY_OPEN_PANELS = 'openPanels'
const KEY_APPROVAL_MODES = 'approvalModes'

type IdMap = Record<string, string>
type TabMap = Record<string, number>
type FlagMap = Record<string, true>
type ModeMap = Record<string, string>

async function read<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.session.get(key)
  return (stored[key] as T) ?? fallback
}

async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value })
}

export async function getSessionForTab(tabId: number): Promise<string | null> {
  const map = await read<IdMap>(KEY_TAB_SESSIONS, {})
  return map[String(tabId)] ?? null
}

export async function getTabForSession(sessionId: string): Promise<number | null> {
  const map = await read<TabMap>(KEY_SESSION_TABS, {})
  return map[sessionId] ?? null
}

/** Bind a tab to a session (idempotent; the previous binding is dropped). */
export async function bindTabSession(tabId: number, sessionId: string): Promise<void> {
  const [tabSessions, sessionTabs] = await Promise.all([
    read<IdMap>(KEY_TAB_SESSIONS, {}),
    read<TabMap>(KEY_SESSION_TABS, {}),
  ])
  for (const [sid, tid] of Object.entries(sessionTabs)) {
    if (tid === tabId) delete sessionTabs[sid]
  }
  tabSessions[String(tabId)] = sessionId
  sessionTabs[sessionId] = tabId
  await Promise.all([
    write(KEY_TAB_SESSIONS, tabSessions),
    write(KEY_SESSION_TABS, sessionTabs),
  ])
}

/** Drop a tab's binding entirely (tab closed). */
export async function clearTab(tabId: number): Promise<void> {
  const [tabSessions, sessionTabs] = await Promise.all([
    read<IdMap>(KEY_TAB_SESSIONS, {}),
    read<TabMap>(KEY_SESSION_TABS, {}),
  ])
  const sessionId = tabSessions[String(tabId)]
  delete tabSessions[String(tabId)]
  if (sessionId) delete sessionTabs[sessionId]
  await Promise.all([
    write(KEY_TAB_SESSIONS, tabSessions),
    write(KEY_SESSION_TABS, sessionTabs),
  ])
}

/** Forget a session everywhere (it was deleted; no tab should point at it). */
export async function clearSession(sessionId: string): Promise<void> {
  const [tabSessions, sessionTabs] = await Promise.all([
    read<IdMap>(KEY_TAB_SESSIONS, {}),
    read<TabMap>(KEY_SESSION_TABS, {}),
  ])
  delete sessionTabs[sessionId]
  for (const [tid, sid] of Object.entries(tabSessions)) {
    if (sid === sessionId) delete tabSessions[tid]
  }
  await Promise.all([
    write(KEY_TAB_SESSIONS, tabSessions),
    write(KEY_SESSION_TABS, sessionTabs),
  ])
}

export async function isPanelOpen(tabId: number): Promise<boolean> {
  const map = await read<FlagMap>(KEY_OPEN_PANELS, {})
  return map[String(tabId)] === true
}

export async function setPanelOpen(tabId: number, open: boolean): Promise<void> {
  const map = await read<FlagMap>(KEY_OPEN_PANELS, {})
  if (open) map[String(tabId)] = true
  else delete map[String(tabId)]
  await write(KEY_OPEN_PANELS, map)
}

/** The tab's last 授权 choice. Kept here because a tab can set it *before* its
 *  session exists (the panel is open, no message sent yet) — the choice has to
 *  survive until the session is created and can carry a stored approval_mode.
 *  Once a session exists the desktop's `conversations.approval_mode` is the
 *  authority and the snapshot prefers it. */
export async function getTabApprovalMode(tabId: number): Promise<SandboxApprovalMode | null> {
  const map = await read<ModeMap>(KEY_APPROVAL_MODES, {})
  return toSandboxApprovalMode(map[String(tabId)]) ?? null
}

export async function setTabApprovalMode(tabId: number, mode: SandboxApprovalMode): Promise<void> {
  const map = await read<ModeMap>(KEY_APPROVAL_MODES, {})
  map[String(tabId)] = mode
  await write(KEY_APPROVAL_MODES, map)
}
