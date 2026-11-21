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
import { cacheHitRate, describeSentAt, formatTokenCount } from '../src/shared/ui/message-stats'

const REPO = join(__dirname, '..')
const GROUP = readFileSync(join(REPO, 'src', 'renderer', 'src', 'components', 'chat', 'MessageGroup.tsx'), 'utf-8')
const PANEL_FORMAT = readFileSync(join(REPO, 'src', 'extension', 'ui', 'format.ts'), 'utf-8')
const PANEL_BLOCKS = readFileSync(join(REPO, 'src', 'extension', 'ui', 'MessageBlocks.tsx'), 'utf-8')

describe('shared message-stats formatters (the 2026-11-01 min/k wording)', () => {
  it('sent-at stamp: local date parts and clock, null for missing/unparsable (2026-11-21)', () => {
    // 2026-11-21 裁定退役了耗时档位（formatDuration 整体删除），工具条的时间
    // 位是日历戳——用户气泡的发送时间与助手气泡的完成时间共用同一组纯函数。
    // 本地时区钉住：用带时区的构造再读回 parts。
    const at = new Date(2026, 10, 6, 18, 2) // local 2026-11-06 18:02
    const sent = describeSentAt(at.toISOString())
    expect(sent).toEqual({ clock: '18:02', year: 2026, month: 11, day: 6 })
    expect(describeSentAt(at.getTime())).toEqual(sent) // number 形同形
    expect(describeSentAt(at)).toEqual(sent) // Date 形同形
    expect(describeSentAt(undefined)).toBeNull()
    expect(describeSentAt(null)).toBeNull()
    expect(describeSentAt('not a timestamp')).toBeNull()
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

  // The per-message line and the ring's session line must be the same
  // arithmetic — cacheHitRate routes through computeCacheHitRate's
  // single-sample path for exactly that reason. These pin the two guards the
  // shared path adds; without them a gateway reporting more cache reads than
  // prompt tokens would print "226%" for one message while the session line
  // over that same message read "100%".
  it('cache hit rate inherits the aggregator guards: clamp at 100%, never NaN', () => {
    expect(cacheHitRate(120, 100)).toBe('100%') // cacheRead > prompt clamps instead of printing 120%
    expect(cacheHitRate(0, 0)).toBe('0%') // empty denominator reads 0% instead of NaN%
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
    // The 2026-11-21 ruling retired the duration tier — the panel must not
    // re-export it back in (describeSentAt replaces it for the stamp).
    expect(PANEL_FORMAT).not.toContain('formatDuration')
    expect(PANEL_FORMAT).toContain('describeSentAt')
    // The panel's consumer surface is unchanged: MessageBlocks still reads
    // './format' (the import path is part of the hand-mirroring contract).
    expect(PANEL_BLOCKS).toContain("from './format'")
  })
})
