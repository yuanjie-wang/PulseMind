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

export type BindingProblem = 'conflict' | 'reserved' | 'no-modifier' | 'invalid'

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
