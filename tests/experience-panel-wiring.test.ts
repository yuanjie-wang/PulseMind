// 经验面板 wiring — source scans (vitest here is node-env; the settings page
// cannot mount), in the shape of office-tools-wiring. Covers the 清空 button's
// five-hop chain (panel → bridge → preload → handler → store) and the
// 「最多保留 N 条经验」tip's dismiss-persistence (SkillsPanel's localStorage
// pattern). Non-vacuity: each scan names content whose removal is exactly what
// would break the feature or resurrect the tip silently.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('experience clear-all wiring', () => {
  const channels = read('src/shared/ipc-channels.ts')
  const handler = read('src/main/ipc/experiences.handler.ts')
  const store = read('src/main/storage/experience-store.ts')
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')
  const panel = read('src/renderer/src/components/settings/ExperiencePanel.tsx')

  it('the clear channel is registered main-side, exposed via preload, typed on the bridge, and called by the panel', () => {
    expect(channels).toContain(`EXPERIENCES_CLEAR: 'experiences:clear'`)
    expect(handler).toContain('IPC_CHANNELS.EXPERIENCES_CLEAR')
    expect(handler).toContain('experienceStore.clear()')
    // the clear broadcasts the same changed event single deletes do
    expect(handler).toMatch(/EXPERIENCES_CLEAR[\s\S]*?EXPERIENCES_CHANGED/)
    expect(preload).toContain('clearExperiences: (): Promise<number>')
    expect(bridge).toContain('clearExperiences: () => Promise<number>')
    expect(panel).toContain('window.electronAPI.clearExperiences()')
  })

  it('store.clear removes the rows AND the record dirs, like delete does for one', () => {
    expect(store).toMatch(/async clear\(\)[\s\S]*?DELETE FROM experiences[\s\S]*?rm\(join\(EXPERIENCES_DIR/)
  })

  it('the panel clear button carries the confirm dialog and only shows when there is something to clear', () => {
    expect(panel).toMatch(/experiences\.length > 0 && \(?[\s\S]*?Popconfirm/)
    expect(panel).toContain('这将删除全部 ${experiences.length} 条经验。')
    expect(panel).toContain('okButtonProps={{ danger: true }}')
  })
})

describe('experience tip dismissal', () => {
  const panel = read('src/renderer/src/components/settings/ExperiencePanel.tsx')

  it('the cap Alert is closable and the dismissal persists across sessions', () => {
    expect(panel).toContain("const DISMISS_TIP_KEY = 'pulsemind_dismissed_experience_tip'")
    expect(panel).toContain("localStorage.getItem(DISMISS_TIP_KEY) === 'true'")
    expect(panel).toContain("localStorage.setItem(DISMISS_TIP_KEY, 'true')")
    expect(panel).toMatch(/closable\s*\n?\s*onClose=\{dismissTip\}/)
    // the tip stays gated behind the flag — removing the gate resurrects it
    expect(panel).toContain('{!tipDismissed && (')
    expect(panel).toContain('最多保留 ${MAX_EXPERIENCES} 条经验')
  })

  it('the scan itself is non-vacuous (sentinel text exists in the panel source)', () => {
    expect(panel).toContain('DISMISS_TIP_KEY')
  })
})
