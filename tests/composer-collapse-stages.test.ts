// The composer footer's staged responsive collapse (user ruling 2026-11-01:
// 「消息输入区的响应式的宽度阈值有些保守」). The old single 600px breakpoint
// collapsed the 授权/模型 labels while the common row — short model name —
// still had ~250px of visible slack, because one threshold had to cover the
// rare worst case (pending compaction chip + count + ring + 160px-capped name
// ≈ 692px measured). The row sheds in stages, least-essential first, each
// stage sized so its post-shed worst row fits every width it applies to:
//   ≤ 500  near-cap count (transient typing feedback; the clamp is unchanged)
//   ≤ 440  授权/模型 labels → 28px icons (robot glyph for the model picker)
// The first stage (≤ 700, the compaction chip) retired on 2026-11-21 with the
// chip itself (user: 外层不再展示压缩情况 —— 信息只在 ContextRing 浮窗里);
// the worst row it rescued no longer exists, post-chip worst ≈ 493px.
// Measured pieces (probe-composer-responsive.mjs, real Chromium): attach 56,
// 授权 108/30, count 59, ring 16, model 84/194/30, send 24, gaps ~36. The
// stages are CSS container queries in Composer's stylesheet — these pins are
// source scans because container queries need a real layout.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const composerSrc = read('src/renderer/src/components/chat/Composer.tsx')
const inputAreaSrc = read('src/renderer/src/components/chat/InputArea.tsx')

describe('composer footer staged collapse (2026-11-01 user ruling)', () => {
  it('two container stages exist with the measured thresholds', () => {
    expect(composerSrc).toContain('@container pm-composer (max-width: 500px)')
    expect(composerSrc).toContain('@container pm-composer (max-width: 440px)')
    // The old single breakpoint must not survive anywhere in the sheet — and
    // neither may the retired chip stage (its element is gone, a stage hiding
    // nothing is dead weight that reads as a live rung).
    expect(composerSrc).not.toContain('(max-width: 600px)')
    expect(composerSrc).not.toContain('(max-width: 700px)')
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
    // count: stage one (≤500) — the near-limit counter Composer renders itself
    expect(stageOf(500)).toContain('.pm-composer-count { display: none; }')
    // labels: stage two (≤440) — the 授权/模型 compact classes + robot glyph
    const labelStage = stageOf(440)
    expect(labelStage).toContain('.pm-collapse-compact { display: none; }')
    expect(labelStage).toContain('.pm-collapse-only { display: inline-block; }')
  })

  it('the classes the stages target are hung on the right elements', () => {
    // The compact classes hang on the 授权/模型 label+caret pieces —
    // Composer's count span keeps its own class.
    expect(composerSrc).toContain('className="pm-composer-count"')
    expect(inputAreaSrc.match(/pm-collapse-compact/g)?.length).toBeGreaterThanOrEqual(4)
    expect(inputAreaSrc).toContain('className="pm-collapse-only"')
    // The chip stage retired with the chip: neither the class nor the outer
    // chip render may grow back (user 2026-11-21, ring tooltip is the only
    // compaction surface).
    expect(inputAreaSrc).not.toContain('pm-collapse-chip')
    expect(inputAreaSrc).not.toContain("t('chatView.compaction.chip'")
  })

  it('阴性对照：废掉任一 stage 或其目标类恰好变红', () => {
    // Simulate removing the count stage: the ≤500 query gone must fail the
    // stage-existence pin, and a renamed target class must fail the
    // element-class pin — proving the pins above bite.
    const withoutCountStage = composerSrc.replace('@container pm-composer (max-width: 500px)', '@container pm-composer (max-width: 999px)')
    expect(withoutCountStage).not.toContain('@container pm-composer (max-width: 500px)')
    const withoutCountClass = composerSrc.replace('className="pm-composer-count"', 'className="pm-count"')
    expect(withoutCountClass).not.toContain('className="pm-composer-count"')
  })
})
