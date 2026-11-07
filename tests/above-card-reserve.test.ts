// ── Above-card reserve (aboveCard 槽位的下方预留) ──
// The aboveCard slot (topSlot plan strip + the staged strip) is absolutely
// positioned over the transcript, so it needs its own bottom padding — the
// composer's fixed 160px band does not include it. Without the reserve the
// newest message is painted over by the strip (user report 2026-11-04:
// 「暂存消息会遮挡底部的最新消息」).
//
// Round 2 of the same report: the 160 was ALSO only ever right for a one-line
// card. The Sender autosizes, so a five-line draft grows the card band from 126
// to 214 and the newest message slid under the card — and under the strip above
// it — even with the slot reserve in place. The band is therefore measured
// (Composer → InputArea → ChatBody) and 160 became a floor.
//
// vitest is node-env, so the wiring is asserted as source scans (house style,
// see tests/staged-queue-wiring.test.ts). Real geometry — the message actually
// clearing the strip, the band actually following a typed draft, the re-pin
// keeping the tail in view — is verified by scripts/probe-above-card-reserve.mjs
// (one-line baseline) and scripts/probe-staged-overlap-realhost.mjs (real
// AppLayout + a five-line draft).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const COMPOSER = read('src', 'renderer', 'src', 'components', 'chat', 'Composer.tsx')
const INPUT_AREA = read('src', 'renderer', 'src', 'components', 'chat', 'InputArea.tsx')
const CHAT_BODY = read('src', 'renderer', 'src', 'components', 'chat', 'ChatBody.tsx')

describe('Composer: the anchor gap is one exported constant', () => {
  it('exports ABOVE_CARD_GAP and anchors with it (no second literal)', () => {
    expect(COMPOSER).toContain('export const ABOVE_CARD_GAP = 8')
    // The anchor style must read the constant — a hardcoded 8px would let the
    // transcript's reserve (height + ABOVE_CARD_GAP) drift from the real gap.
    expect(COMPOSER).toContain('bottom: `calc(100% + ${ABOVE_CARD_GAP}px)`')
    expect(COMPOSER).not.toContain("bottom: 'calc(100% + 8px)'")
  })
})

describe('InputArea: measures the persistent above-card group', () => {
  it('imports the shared gap and reports height + gap', () => {
    expect(INPUT_AREA).toContain('ABOVE_CARD_GAP')
    expect(INPUT_AREA).toContain('node.offsetHeight + ABOVE_CARD_GAP')
    expect(INPUT_AREA).toContain('onAboveCardReserve')
    // ResizeObserver, not a one-shot measure: rows are staged/removed and the
    // plan strip appears while the composer stays mounted.
    expect(INPUT_AREA).toContain('new ResizeObserver(report)')
    expect(INPUT_AREA).toContain('ro.observe(node)')
    // Unmount releases the reserve instead of pinning the host to a stale one.
    expect(INPUT_AREA).toMatch(/return \(\) => \{[\s\S]{0,200}onAboveCardReserve\(0\)/)
  })

  it('keeps the transient overlays outside the measured wrapper', () => {
    const wrapStart = INPUT_AREA.indexOf('data-above-card-reserve')
    expect(wrapStart).toBeGreaterThan(-1)
    // The measured wrapper holds topSlot + the staged strip only…
    const wrap = INPUT_AREA.slice(wrapStart, INPUT_AREA.indexOf('data-mention-popup'))
    expect(wrap).toContain('data-staged-strip')
    expect(wrap).toContain('{topSlot &&')
    // …and the mention popup / drop hint come AFTER it. Reserving for them
    // would pump the transcript on every `@` keystroke and every drag.
    expect(INPUT_AREA.indexOf('data-mention-popup')).toBeGreaterThan(wrapStart)
    expect(INPUT_AREA.indexOf('data-drop-hint')).toBeGreaterThan(wrapStart)
    expect(wrap).not.toContain('data-drop-hint')
  })

  it('moves the strip’s vertical spacing into the wrapper gap', () => {
    // A margin on the strip is height the measured node does not report (it
    // sits outside offsetHeight) — the last message would peek under the strip
    // by exactly that margin.
    expect(INPUT_AREA).toContain('gap: ABOVE_CARD_GAP')
    expect(INPUT_AREA).not.toContain("margin: '8px auto',\n                        maxHeight: 200")
  })

  it('keeps the strip at the card’s width inside the flex wrapper', () => {
    // The measured wrapper is a flex COLUMN. `margin: 0 auto` on a flex item
    // beats `align-self: stretch`, so the strip shrink-to-fits its rows unless
    // the width is explicit (measured 245 vs the card's 952 — user report
    // 「还把暂存区宽度缩小了」). border-box keeps the 952 cap inclusive of the
    // strip's own padding/border (content-box measured 970).
    expect(INPUT_AREA).toContain("width: '100%'")
    expect(INPUT_AREA).toContain("boxSizing: 'border-box'")
    // Both numbers sit on the same element as the maxWidth they belong to.
    const strip = INPUT_AREA.slice(INPUT_AREA.indexOf('data-staged-strip'), INPUT_AREA.indexOf('data-staged-item'))
    expect(strip).toContain('maxWidth: COMPOSER_MAX_WIDTH')
    expect(strip).toContain("width: '100%'")
    expect(strip).toContain("boxSizing: 'border-box'")
  })
})

describe('Composer: the card band is measured, not assumed', () => {
  it('reports root.bottom − column.top through a ResizeObserver', () => {
    expect(COMPOSER).toContain('onCardBand')
    // The band is the thing the fixed 160 stood in for: root padding + the
    // (autosizing) card. Measuring the inner column's top against the root's
    // bottom edge survives chips, header growth and draft rows alike.
    expect(COMPOSER).toContain('root.getBoundingClientRect().bottom - column.getBoundingClientRect().top')
    expect(COMPOSER).toMatch(/new ResizeObserver\(report\)[\s\S]{0,200}ro\.observe\(column\)/)
    // Inline layout has no floating card to clear — reporting a band there
    // would inflate the transcript's spacer for no reason.
    expect(COMPOSER).toMatch(/layout !== 'floating'[\s\S]{0,120}onCardBand\(0\)/)
    // Unmount releases the band instead of pinning the host to a stale one.
    expect(COMPOSER).toMatch(/ro\.disconnect\(\)[\s\S]{0,300}onCardBand\(0\)/)
  })
})

describe('ChatBody: dynamic spacer + at-tail re-pin', () => {
  it('adds the measured band and the reserve to the composer spacer', () => {
    // 160 is the FLOOR (the one-line band is 126), never the number: a tall
    // draft must grow the spacer with the card.
    expect(CHAT_BODY).toContain('Math.max(160, composerBand + TRANSCRIPT_TAIL_GAP) + aboveCardReserve')
    expect(CHAT_BODY).toContain('paddingBottom: composerPad')
    // The spacer carries the probe's hook — without it the probe would have to
    // guess the element by position and would silently measure a banner.
    expect(CHAT_BODY).toContain('data-pm-composer-spacer')
    expect(CHAT_BODY).toContain('<InputArea')
    expect(CHAT_BODY).toContain('onAboveCardReserve={setAboveCardReserve}')
    expect(CHAT_BODY).toContain('onCardBand={setComposerBand}')
  })

  it('re-pins only for a reader who was at the tail', () => {
    // The flag is written by the scroll handler (pre-update reading) — the
    // point of the re-pin is that padding growth itself makes the tail look
    // far away, so measuring after the update can never see "was at tail".
    expect(CHAT_BODY).toContain('atTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100')
    expect(CHAT_BODY).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,500}if \(!el \|\| !atTailRef\.current\) return[\s\S]{0,200}el\.scrollTop = el\.scrollHeight/)
    // Hooks live before the welcome early-return (hook order must not change
    // with the arm).
    expect(CHAT_BODY.indexOf('const [aboveCardReserve')).toBeLessThan(CHAT_BODY.indexOf('if (welcome)'))
  })
})
