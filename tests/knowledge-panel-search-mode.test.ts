// PLAN-knowledge-groups R1: the full-text search mode needs its toggle to be
// RENDERED. The K7② implementation shipped the two-mode loadFiles wiring and
// the mode-aware placeholder — but `setSearchMode` had zero call sites, so
// mode='fulltext' was unreachable and nothing failed. vitest here is node-env
// (no jsdom, the panel cannot be mounted), so the wiring is asserted as
// source, the same way tests/expert-delegation.test.ts pins the ask chain.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const panel = readFileSync(join(ROOT, 'src/renderer/src/components/knowledge/KnowledgePanel.tsx'), 'utf-8')
const zh = readFileSync(join(ROOT, 'src/renderer/src/i18n/locales/zh.ts'), 'utf-8')
const en = readFileSync(join(ROOT, 'src/renderer/src/i18n/locales/en.ts'), 'utf-8')

describe('knowledge panel search mode (R1)', () => {
  it('non-vacuity: the scan reads the real panel source (a broken path cannot pass by finding nothing)', () => {
    expect(panel).toContain("useState<'name' | 'fulltext'>('name')")
  })

  it('setSearchMode has a call site — the mode toggle is rendered, not just declared', () => {
    // The declaration reads `setSearchMode] = useState`, so every
    // `setSearchMode(` occurrence IS a call site. R1 shipped with exactly zero
    // (dead state); the Segmented onChange is the one that must exist.
    const callSites = panel.split('setSearchMode(').length - 1
    expect(callSites).toBeGreaterThanOrEqual(1)
    expect(panel).toContain('Segmented')
  })

  it('the full-text branch actually queries content (the K5-ranked search), not just a placeholder swap', () => {
    expect(panel).toContain("searchMode === 'fulltext'")
    // Scoped (2026-09-18 rail layout): the query rides the panel's baseId —
    // the bare two-arg-less call would search across every base again.
    expect(panel).toContain('knowledgeManager.searchContent(searchQuery, scopedBaseId)')
  })

  it('both locales label the two modes (an untranslated Segmented renders [i18n] keys)', () => {
    for (const locale of [zh, en]) {
      expect(locale).toMatch(/searchModeName: '(.+)'/)
      expect(locale).toMatch(/searchModeFulltext: '(.+)'/)
    }
  })
})
