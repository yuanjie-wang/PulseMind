// ── Command palette items (pure half) ──
// What the palette can reach and how a query narrows it. Pure so vitest can
// drive both halves; the component (CommandPalette.tsx) renders and runs.
//
// buildCommandItems takes pre-translated labels (the component's caller holds
// useTranslation, this file must not) and every action as a closure. Item
// order is display order: actions, views, conversations, projects, settings.
//
// filterCommandItems is a forgiving subsequence match with a light score —
// consecutive-character runs and word-start hits rank above scattered ones,
// so "新建" puts 新建任务 above 打开搜索 and "she" finds 设置 before deep
// matches. No dependency: this app's titles are mostly CJK, where a plain
// subsequence is exactly the right primitive (pinyin is a future concern).

export interface CommandItem {
  /** Stable id — also the React key. */
  id: string
  label: string
  /** Display group; the palette prints a divider whenever it changes. */
  group: string
  /** Right-aligned accelerator hint, e.g. ⌘N. Presentational only. */
  hint?: string
  run: () => void
}

export interface CommandPaletteSources {
  labels: {
    groupActions: string
    groupViews: string
    groupConversations: string
    groupProjects: string
    groupSettings: string
    newTask: string
    newProject: string
    toggleSidebar: string
    toggleWorkbench: string
    openSearch: string
    openUsage: string
    openSettings: string
    /** Prefix before a conversation title, e.g. 「打开会话 · 」. */
    openConversation: string
    /** Prefix before a project name. */
    newTaskInProject: string
    /** Prefix before a settings section name. */
    settingsSection: string
  }
  /** Accelerator hints; a missing entry omits the hint (Windows/Linux shows
   *  Ctrl twins, mac shows ⌘ — or nothing, callers decide). */
  hints?: Partial<Record<'newTask' | 'newProject' | 'toggleSidebar' | 'toggleWorkbench' | 'openSearch' | 'openUsage' | 'openSettings', string>>
  conversations: Array<{ key: string; label: string }>
  projects: Array<{ id: string; name: string }>
  /** Pre-translated settings sections, in display order. */
  settingsSections: Array<{ key: string; label: string }>
  run: {
    newTask(): void
    newProject(): void
    toggleSidebar(): void
    toggleWorkbench(): void
    openSearch(): void
    openUsage(): void
    openSettings(): void
    openSettingsSection(tab: string): void
    openConversation(key: string): void
    newTaskInProject(projectId: string): void
  }
}

export function buildCommandItems(s: CommandPaletteSources): CommandItem[] {
  const { labels: l, hints } = s
  // Display order: actions, views, conversations, projects, settings —
  // open-settings deliberately lives with the settings block (last), not with
  // the fixed actions, so the group divider never folds back on itself.
  const items: CommandItem[] = [
    { id: 'action:new-task', label: l.newTask, group: l.groupActions, hint: hints?.newTask, run: s.run.newTask },
    { id: 'action:new-project', label: l.newProject, group: l.groupActions, hint: hints?.newProject, run: s.run.newProject },
    { id: 'action:toggle-sidebar', label: l.toggleSidebar, group: l.groupActions, hint: hints?.toggleSidebar, run: s.run.toggleSidebar },
    { id: 'action:toggle-workbench', label: l.toggleWorkbench, group: l.groupActions, hint: hints?.toggleWorkbench, run: s.run.toggleWorkbench },
    { id: 'action:open-search', label: l.openSearch, group: l.groupViews, hint: hints?.openSearch, run: s.run.openSearch },
    { id: 'action:open-usage', label: l.openUsage, group: l.groupViews, hint: hints?.openUsage, run: s.run.openUsage },
  ]
  for (const conv of s.conversations) {
    items.push({
      id: `conv:${conv.key}`,
      label: conv.label || `${l.openConversation}${conv.key}`,
      group: l.groupConversations,
      run: () => s.run.openConversation(conv.key),
    })
  }
  for (const project of s.projects) {
    items.push({
      id: `project:${project.id}`,
      label: `${l.newTaskInProject}${project.name}`,
      group: l.groupProjects,
      run: () => s.run.newTaskInProject(project.id),
    })
  }
  for (const section of s.settingsSections) {
    items.push({
      id: `settings:${section.key}`,
      label: `${l.settingsSection}${section.label}`,
      group: l.groupSettings,
      run: () => s.run.openSettingsSection(section.key),
    })
  }
  items.push({ id: 'action:open-settings', label: l.openSettings, group: l.groupSettings, hint: hints?.openSettings, run: s.run.openSettings })
  return items
}

/** Subsequence match score; 0 = no match. Best window over all matches of the
 *  query's first character (subsequences are greedy-hostile, so we only seed
 *  from each occurrence of q[0] — cheap and correct for the lengths here). */
export function fuzzyScore(haystack: string, query: string): number {
  if (!query) return 1
  let best = 0
  for (let seed = haystack.indexOf(query[0]); seed !== -1; seed = haystack.indexOf(query[0], seed + 1)) {
    const score = scoreFrom(haystack, query, seed)
    if (score > best) best = score
  }
  return best
}

function scoreFrom(haystack: string, query: string, start: number): number {
  let score = 1
  let hi = start
  // prevMatch 是上一个已匹配字符的位置；种子位置本身就是 query[0] 的落点，
  // 所以从这里起步 —— 起成 start-1 会让第一跳的连续加成永远漏掉。
  let prevMatch = start
  for (let qi = 1; qi < query.length; qi++) {
    hi = haystack.indexOf(query[qi], hi + 1)
    if (hi === -1) return 0
    if (hi === prevMatch + 1)
      score += 3 // consecutive run
    else if (isWordStart(haystack, hi)) score += 2
    else score += 1
    prevMatch = hi
  }
  if (start === 0) score += 2 // prefix hit
  return score
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  return /[\s·/:（(-]/.test(prev)
}

export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  const scored: Array<{ item: CommandItem; score: number }> = []
  for (const item of items) {
    const score = fuzzyScore(item.label.toLowerCase(), q)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
