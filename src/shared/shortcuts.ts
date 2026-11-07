// ── App-level keyboard shortcuts: the single source of truth ──
// menu.ts builds the (mac) menu accelerators and the (win/linux)
// before-input fallback from here; the renderer's shortcut settings page and
// the command palette's hints read the same table, so a rebind can never
// leave one surface stating a stale key. Pure logic — importable from main
// and renderer alike, no Electron / DOM access.

export type ShortcutActionId =
  | 'new-task'
  | 'new-project'
  | 'command-palette'
  | 'toggle-sidebar'
  | 'toggle-workbench'
  | 'open-search'
  | 'open-settings'
  | 'open-usage'

export const SHORTCUT_ACTION_IDS: readonly ShortcutActionId[] = [
  'new-task',
  'new-project',
  'command-palette',
  'toggle-sidebar',
  'toggle-workbench',
  'open-search',
  'open-settings',
  'open-usage',
]

/** Defaults in Electron accelerator syntax. Menu-template role accelerators
 *  (⌘W close, ⌘R reload, ⇧⌘I devtools, ⌘Q quit) are deliberately absent —
 *  they belong to Electron roles and are RESERVED for rebinding. */
export const DEFAULT_ACCELERATORS: Record<ShortcutActionId, string> = {
  'new-task': 'CmdOrCtrl+N',
  'new-project': 'CmdOrCtrl+Shift+N',
  'command-palette': 'CmdOrCtrl+K',
  'toggle-sidebar': 'CmdOrCtrl+B',
  'toggle-workbench': 'CmdOrCtrl+J',
  'open-search': 'CmdOrCtrl+F',
  'open-settings': 'CmdOrCtrl+,',
  'open-usage': 'CmdOrCtrl+Alt+U',
}

/** Only the overrides persist (settings.json `shortcuts`); a missing entry
 *  means "default". Recordings serialize to CmdOrCtrl so one settings.json
 *  survives a platform move. */
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string>>

const MODIFIER_NAMES = new Set(['cmdorctrl', 'cmd', 'ctrl', 'alt', 'altgr', 'shift', 'super'])

/** Canonical comparison form: CmdOrCtrl/Cmd/Ctrl/Super all collapse to `mod`
 *  — they describe the same physical chord on this platform, so two bindings
 *  must conflict with each other — Alt/AltGr → `alt`, Shift stays. Modifiers
 *  first in that order, letter keys uppercased. Returns '' when the string
 *  has no key at all. */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return ''
  const key = parts.filter((p) => !MODIFIER_NAMES.has(p.toLowerCase()))
  const mods = parts.filter((p) => MODIFIER_NAMES.has(p.toLowerCase()))
  if (key.length !== 1) return ''
  const collapsed = mods.map((m) => {
    const lower = m.toLowerCase()
    if (lower === 'cmdorctrl' || lower === 'cmd' || lower === 'ctrl' || lower === 'super') return 'mod'
    if (lower === 'altgr') return 'alt'
    return lower
  })
  const order = ['mod', 'alt', 'shift']
  const sorted = order.flatMap((name) => collapsed.filter((m) => m === name))
  const normalizedKey = /^[a-z]$/i.test(key[0]) ? key[0].toUpperCase() : key[0]
  return [...sorted, normalizedKey].join('+')
}

export function effectiveAccelerators(overrides?: ShortcutOverrides): Record<ShortcutActionId, string> {
  return { ...DEFAULT_ACCELERATORS, ...(overrides ?? {}) }
}

export type BindingProblem = 'conflict' | 'reserved' | 'no-modifier' | 'platform-modifier' | 'invalid'

export interface BindingValidation {
  ok: boolean
  problem?: BindingProblem
  conflictWith?: ShortcutActionId
}

/** Role accelerators the menu template already owns (menu.ts roles); a rebind
 *  onto one would shadow or duplicate Electron's own handling. The roles fire
 *  on BOTH platforms (the non-darwin template is installed too, just not
 *  visible), so the Ctrl twins are as off-limits as the ⌘ forms. */
const RESERVED_ACCELERATORS = ['CmdOrCtrl+W', 'CmdOrCtrl+R', 'CmdOrCtrl+Shift+I', 'CmdOrCtrl+Q', 'CmdOrCtrl+M']

export function validateBinding(
  action: ShortcutActionId,
  accelerator: string,
  current: Record<ShortcutActionId, string>,
): BindingValidation {
  const norm = normalizeAccelerator(accelerator)
  if (!norm) return { ok: false, problem: 'invalid' }
  // Cmd/Super name a mac-only chord: on win/linux the fallback table drops
  // them (fallbackComboFor), so a Super-only binding degrades to a BARE key —
  // a global typing hijack. CmdOrCtrl is the portable spelling and what the
  // recorder emits, so a hand-edited Cmd/Super form is rejected everywhere
  // (checked on the RAW parts: normalizeAccelerator has already collapsed
  // cmd/super into `mod`, indistinguishable from Ctrl).
  const rawMods = accelerator.split('+').map((p) => p.trim().toLowerCase())
  if (rawMods.includes('cmd') || rawMods.includes('super')) {
    return { ok: false, problem: 'platform-modifier' }
  }
  const mods = norm.split('+').slice(0, -1)
  // Shift alone would fire while the user types capital letters — a real
  // modifier (the collapsed Cmd/Ctrl family, or Alt) is required.
  if (!mods.some((m) => m === 'mod' || m === 'alt')) {
    return { ok: false, problem: 'no-modifier' }
  }
  if (RESERVED_ACCELERATORS.some((r) => normalizeAccelerator(r) === norm)) {
    return { ok: false, problem: 'reserved' }
  }
  for (const id of SHORTCUT_ACTION_IDS) {
    if (id !== action && normalizeAccelerator(current[id]) === norm) {
      return { ok: false, problem: 'conflict', conflictWith: id }
    }
  }
  return { ok: true }
}

/** Electron accelerator → the before-input-event key notation the non-darwin
 *  fallback table (menu.ts) is keyed on: CmdOrCtrl/Ctrl resolve to ctrl,
 *  alt/altgr → alt, shift stays, and the modifiers are emitted in the SAME
 *  fixed order (ctrl→alt→shift) the input side reads them, so a hand-edited
 *  'Shift+Alt+P' collides with the input's 'alt+shift+p' instead of missing
 *  it. Returns null when no table-worthy combo remains: cmd/super drop (they
 *  never fire on a PC keyboard) and shift alone is how capital letters get
 *  typed — an entry without ctrl/alt left would preventDefault every plain
 *  press of its key (typing "n" would fire 新建任务), which is the load-path
 *  backstop for a hand-edited settings.json and mirrors validateBinding's own
 *  modifier rule. */
export function fallbackComboFor(accelerator: string): string | null {
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.filter((p) => !MODIFIER_NAMES.has(p.toLowerCase()))[0]
  if (key === undefined) return null
  const flags = new Set(
    parts.flatMap((p) => {
      const lower = p.toLowerCase()
      if (lower === 'cmdorctrl' || lower === 'ctrl') return ['ctrl']
      if (lower === 'alt' || lower === 'altgr') return ['alt']
      if (lower === 'shift') return ['shift']
      return []
    }),
  )
  const combo = ['ctrl', 'alt', 'shift'].filter((f) => flags.has(f))
  if (!combo.includes('ctrl') && !combo.includes('alt')) return null
  return [...combo, key.toLowerCase()].join('+')
}

/** Focus gate for the mac app-menu dispatch (menu.ts). The application menu
 *  is app-global: with a popout / immersive / hook-browser window focused, an
 *  accelerator still fires the menu item, and dispatching to the main window
 *  then makes it answer ⌘N/⌘K behind the user's back. So a keyboard
 *  accelerator (triggeredByAccelerator) is swallowed while the main window is
 *  not focused; a real menu click always dispatches — the user aimed at the
 *  item, and the main window is the only surface implementing the actions. */
export function shouldDispatchMenuAction(viaAccelerator: boolean, mainWindowFocused: boolean): boolean {
  return !viaAccelerator || mainWindowFocused
}

const MAC_KEY_LABELS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Esc: '⎋',
  Space: '␣',
}

/** Display form: `⇧ ⌘ N` on macOS (Control ⌃ · Option ⌥ · Shift ⇧ · Command ⌘,
 *  in that order), `Ctrl+Shift+N` elsewhere. The mac glyphs ride a thin space
 *  (U+2009) — native menus concatenate ⇧⌘N tightly, but in a UI font that
 *  reads as one blob, so each glyph gets its own air. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return ''
  const rawKey = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  const keyLabel = /^[a-z]$/i.test(rawKey) ? rawKey.toUpperCase() : (MAC_KEY_LABELS[rawKey] ?? rawKey)
  if (!isMac) {
    const winMods = mods.map((m) => {
      const lower = m.toLowerCase()
      if (lower === 'cmdorctrl' || lower === 'cmd' || lower === 'super') return 'Ctrl'
      if (lower === 'altgr') return 'Alt'
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    return [...winMods, keyLabel].join('+')
  }
  const symbols: string[] = []
  for (const [name, sym] of [
    ['ctrl', '⌃'],
    ['alt', '⌥'],
    ['altgr', '⌥'],
    ['shift', '⇧'],
    ['cmd', '⌘'],
    ['cmdorctrl', '⌘'],
    ['super', '⌘'],
  ] as const) {
    if (mods.some((m) => m.toLowerCase() === name)) symbols.push(sym)
  }
  return [...symbols, keyLabel].join('\u2009')
}
