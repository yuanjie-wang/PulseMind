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
const KEY_MODEL_IDS = 'modelIds'
const KEY_TAB_SCOPES = 'tabScopes'

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

/** Bind a tab to a session (idempotent; the previous binding is dropped).
 *
 * The cleanup is symmetric in BOTH directions: this tab's previous session is
 * released, and any OTHER tab still pointing at this session is released too —
 * the session now routes here, so a stale `tabSessions[oldTab] = sessionId`
 * would let the old tab's panel believe it still owns the session while every
 * event is delivered to the new one (its asks would vanish into a transcript
 * it never receives). Hit for real by resuming one session from two tabs. */
export async function bindTabSession(tabId: number, sessionId: string): Promise<void> {
  const [tabSessions, sessionTabs] = await Promise.all([
    read<IdMap>(KEY_TAB_SESSIONS, {}),
    read<TabMap>(KEY_SESSION_TABS, {}),
  ])
  for (const [sid, tid] of Object.entries(sessionTabs)) {
    if (tid === tabId) delete sessionTabs[sid]
  }
  for (const [tid, sid] of Object.entries(tabSessions)) {
    if (sid === sessionId && tid !== String(tabId)) delete tabSessions[tid]
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

/** The tab's 历史会话 scope (2026-11-03): one Chrome tab owns one scope, so its
 *  history list survives refresh and navigation (a refresh keeps the tab id)
 *  while another tab's list stays separate. Minted once per tab and kept in
 *  session storage — the same store as the tab↔session binding, because both
 *  must outlive MV3 worker restarts.
 *
 *  A random token rather than the raw tab id: tab ids are only unique within
 *  one browser session and Chrome reuses them across restarts, while this
 *  storage area is cleared when the browser closes — so a new tab can never
 *  inherit a previous browser session's conversations.
 *
 *  Minting is serialized through a promise chain (review_20261104 中4): the
 *  read-modify-write spans the whole map, and two concurrent first calls for
 *  the same tab (panel/attach 的 inventory 与首条消息的 createSession 竞争)
 *  each minted off the stale map — the loser's write clobbered the winner's,
 *  but the loser's token was already stamped on a conversation, which then
 *  never appeared in its own tab's list. Joining the chain makes the second
 *  caller read the map only after the first one's write has landed. */
let tabScopeChain: Promise<unknown> = Promise.resolve()

export async function getTabScope(tabId: number): Promise<string> {
  const run = tabScopeChain.then(async () => {
    const map = await read<IdMap>(KEY_TAB_SCOPES, {})
    const existing = map[String(tabId)]
    if (existing) return existing
    const minted = `tab_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
    map[String(tabId)] = minted
    await write(KEY_TAB_SCOPES, map)
    return minted
  })
  // A failed mint must not poison every queued caller behind it.
  tabScopeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Every scope minted in this browser session (review_20261104 中3): sent
 *  with `session.list` so the service can tell live scopes from dead ones
 *  (previous browser sessions — their storage was cleared on exit) and hand
 *  the dead rows back to adoption instead of letting them strand. */
export async function getLiveTabScopes(): Promise<string[]> {
  const map = await read<IdMap>(KEY_TAB_SCOPES, {})
  return Object.values(map)
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

/** The carried choice was consumed (ensureSession applied it to the session
 *  that just appeared): drop it, or it would resurface onto every later
 *  session this tab creates from scratch — a pick from several sessions ago
 *  silently pinning a fresh conversation. */
export async function clearTabApprovalMode(tabId: number): Promise<void> {
  const map = await read<ModeMap>(KEY_APPROVAL_MODES, {})
  delete map[String(tabId)]
  await write(KEY_APPROVAL_MODES, map)
}

/** The tab's pre-session 模型 choice, same contract as the 授权 one above: a
 *  panel can pick a model before its session exists, so the choice waits here
 *  and ensureSession applies it to the conversation the first message creates.
 *  The conversation's `profile_id` column is then the authority. */
export async function getTabModelId(tabId: number): Promise<string | null> {
  const map = await read<ModeMap>(KEY_MODEL_IDS, {})
  return map[String(tabId)] ?? null
}

export async function setTabModelId(tabId: number, profileId: string): Promise<void> {
  const map = await read<ModeMap>(KEY_MODEL_IDS, {})
  map[String(tabId)] = profileId
  await write(KEY_MODEL_IDS, map)
}

/** Consumed pre-session 模型 choice — same contract as clearTabApprovalMode. */
export async function clearTabModelId(tabId: number): Promise<void> {
  const map = await read<ModeMap>(KEY_MODEL_IDS, {})
  delete map[String(tabId)]
  await write(KEY_MODEL_IDS, map)
}
