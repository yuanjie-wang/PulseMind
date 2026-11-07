// The composer footer's staged responsive collapse (user ruling 2026-11-01:
// 「消息输入区的响应式的宽度阈值有些保守」). The old single 600px breakpoint
// collapsed the 授权/模型 labels while the common row — short model name, no
// compaction chip — still had ~250px of visible slack, because one threshold
// had to cover the rare worst case (pending chip + count + ring + 160px-capped
// name ≈ 692px measured). The row now sheds in stages, least-essential first,
// each stage sized so its post-shed worst row fits every width it applies to:
//   ≤ 700  compaction chip (passive info, tooltip carries the accounting)
//   ≤ 500  near-cap count (transient typing feedback; the clamp is unchanged)
//   ≤ 440  授权/模型 labels → 28px icons (robot glyph for the model picker)
// Measured pieces (probe-composer-responsive.mjs, real Chromium): attach 56,
// 授权 108/30, count 59, chip 199/~150, ring 16, model 84/194/30, send 24,
// gaps ~36. The stages are CSS container queries in Composer's stylesheet —
// these pins are source scans because container queries need a real layout.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const composerSrc = read('src/renderer/src/components/chat/Composer.tsx')
const inputAreaSrc = read('src/renderer/src/components/chat/InputArea.tsx')

describe('composer footer staged collapse (2026-11-01 user ruling)', () => {
  it('three container stages exist with the measured thresholds', () => {
    expect(composerSrc).toContain('@container pm-composer (max-width: 700px)')
    expect(composerSrc).toContain('@container pm-composer (max-width: 500px)')
    expect(composerSrc).toContain('@container pm-composer (max-width: 440px)')
    // The old single breakpoint must not survive anywhere in the sheet.
    expect(composerSrc).not.toContain('(max-width: 600px)')
  })

  it('each stage hides exactly its own element', () => {
    // Slice each @container block out of the sheet by brace counting (blocks
    // contain nested rules, so single-brace matching truncates early).
    const stageOf = (width: number) => {
      const head = `@container pm-composer (max-width: ${width}px)`
      const start = composerSrc.indexOf(head)
      expect(start).toBeGreaterThanOrEqual(0)
      const open = composerSrc.indexOf('{', start)
      let depth = 1
      let i = open + 1
      while (depth > 0 && i < composerSrc.length) {
        if (composerSrc[i] === '{') depth++
        else if (composerSrc[i] === '}') depth--
        i++
      }
      return composerSrc.slice(start, i)
    }
    // chip: stage one (≤700), hung by InputArea on the compaction chip span
    expect(stageOf(700)).toContain('.pm-collapse-chip { display: none; }')
    // count: stage two (≤500) — the near-limit counter Composer renders itself
    expect(stageOf(500)).toContain('.pm-composer-count { display: none; }')
    // labels: stage three (≤440) — the 授权/模型 compact classes + robot glyph
    const labelStage = stageOf(440)
    expect(labelStage).toContain('.pm-collapse-compact { display: none; }')
    expect(labelStage).toContain('.pm-collapse-only { display: inline-block; }')
  })

  it('the classes the stages target are hung on the right elements', () => {
    // InputArea hangs the chip class on the compaction chip span (the one
    // wrapped in the tooltip), and the compact classes on the 授权/模型
    // label+caret pieces — Composer's count span keeps its own class.
    expect(inputAreaSrc).toContain('className="pm-collapse-chip"')
    expect(inputAreaSrc.match(/pm-collapse-compact/g)?.length).toBeGreaterThanOrEqual(4)
    expect(composerSrc).toContain('className="pm-composer-count"')
    expect(inputAreaSrc).toContain('className="pm-collapse-only"')
  })

  it('阴性对照：废掉任一 stage 或其目标类恰好变红', () => {
    // Simulate removing the count stage: the ≤500 query gone must fail the
    // stage-existence pin, and a renamed target class must fail the
    // element-class pin — proving the pins above bite.
    const withoutCountStage = composerSrc.replace('@container pm-composer (max-width: 500px)', '@container pm-composer (max-width: 999px)')
    expect(withoutCountStage).not.toContain('@container pm-composer (max-width: 500px)')
    const withoutChipClass = inputAreaSrc.replace('className="pm-collapse-chip"', 'className="pm-chip"')
    expect(withoutChipClass).not.toContain('className="pm-collapse-chip"')
  })
})
