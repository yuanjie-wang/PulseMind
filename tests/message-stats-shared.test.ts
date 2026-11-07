// ── Message stats wording: one shared source for both chat renderers ──
// review_20261103 中6: the extension panel's private copies of
// formatDuration/formatTokenCount missed the 2026-11-01 min/k rewording, so
// the SAME message read 184.6s / 1,234 in the panel and 3.1min / 1.2k on the
// desktop. The formatters now live in shared/ui/message-stats.ts and both
// sides import them — the tests pin the semantics AND the single-source
// wiring (a re-created private copy fails the negative scans).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cacheHitRate, formatDuration, formatTokenCount } from '../src/shared/ui/message-stats'

const REPO = join(__dirname, '..')
const GROUP = readFileSync(join(REPO, 'src', 'renderer', 'src', 'components', 'chat', 'MessageGroup.tsx'), 'utf-8')
const PANEL_FORMAT = readFileSync(join(REPO, 'src', 'extension', 'ui', 'format.ts'), 'utf-8')
const PANEL_BLOCKS = readFileSync(join(REPO, 'src', 'extension', 'ui', 'MessageBlocks.tsx'), 'utf-8')

describe('shared message-stats formatters (the 2026-11-01 min/k wording)', () => {
  it('duration: ms < 1s, one-decimal s, and ≥2min switches to the minute tier', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(950)).toBe('950ms')
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(105_000)).toBe('105.0s') // 秒档上限内：一位小数
    expect(formatDuration(119_999)).toBe('120.0s')
    expect(formatDuration(120_000)).toBe('2.0min') // 用户裁定档位边界
    expect(formatDuration(186_000)).toBe('3.1min') // 旧面板副本会显示 186.0s 的那条
  })

  it('tokens: below 1000 keeps the locale group, ≥1000 (inclusive) tiers to k', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('1.0k') // 1000 整入档，显示不分叉
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
  })

  it('cache hit rate is the usage pair rounded to a whole percent', () => {
    expect(cacheHitRate(83, 100)).toBe('83%')
    expect(cacheHitRate(0, 100)).toBe('0%')
    expect(cacheHitRate(2, 3)).toBe('67%')
  })
})

describe('both renderers import the shared source (drift is structural, not disciplinary)', () => {
  it('MessageGroup imports from shared/ui/message-stats and keeps no local copy', () => {
    expect(GROUP).toContain("from '../../../../shared/ui/message-stats'")
    // Non-vacuous: a re-created local definition (the old drift shape) fails here.
    expect(GROUP).not.toMatch(/function formatDuration/)
    expect(GROUP).not.toMatch(/function formatTokenCount/)
  })

  it("the panel's format.ts re-exports the shared source and keeps no local copy", () => {
    expect(PANEL_FORMAT).toContain("from '../../shared/ui/message-stats'")
    expect(PANEL_FORMAT).not.toMatch(/export function formatDuration/)
    expect(PANEL_FORMAT).not.toMatch(/export function formatTokenCount/)
    // The panel's consumer surface is unchanged: MessageBlocks still reads
    // './format' (the import path is part of the hand-mirroring contract).
    expect(PANEL_BLOCKS).toContain("from './format'")
  })
})
