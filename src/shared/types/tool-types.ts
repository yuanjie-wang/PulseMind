export interface ToolPreferences {
  enabledTools: string[]
  /** Every tool name the persisted prefs have SEEN (enabled=1 rows and
   *  explicit enabled=0 rows). A built-in absent from here is NEW — it must
   *  surface enabled instead of being hidden by an older whitelist (the
   *  browser tool was lost exactly this way on existing installs). */
  knownTools?: string[]
}
