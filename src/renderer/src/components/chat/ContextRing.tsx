import React from 'react'
import { Tooltip } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import type { AgentMessage } from '../../types/agent'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import { estimateAfterNanoTokens } from '../../agent/engine/context-compactor'

// ── Context usage ring ────────────────────────────────────────────────

// The ring is drawn inside a fixed box, and the drawn circle is inset within it, so the
// box is both the layout size and the largest circle that fits.
const RING_BOX = 24
const RING_CENTER = RING_BOX / 2
const RING_STROKE = 2.5
const DEFAULT_RING_RADIUS = 9
// Keeps the stroke's outer edge off the box edge, where it would be antialiased away.
const RING_INSET = 0.25

export function ContextRing({ used, total, diameter }: { used: number; total: number; diameter?: number }): React.ReactElement | null {
  // Leads the body so the hook still runs on the bail-out path below.
  const { t } = useTranslation()
  if (total <= 0) return null
  const pct = Math.min(used / total, 1)
  // `diameter` asks for the drawn circle's on-screen size, for lining it up with a control
  // of that size. The box does not change, so this never shifts the surrounding layout.
  const r = diameter == null ? DEFAULT_RING_RADIUS : (diameter - RING_STROKE) / 2 - RING_INSET
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)
  // The arc carries no label of its own; the tooltip is where the numbers are read out.
  const percent = Math.round(pct * 100)
  // Both figures read in thousands, the unit the label is written in.
  const inK = (n: number) => `${(n / 1024).toFixed(1)}K`

  return (
    <>
      {/* The hover disc is a CSS rule rather than mouse handlers: Tooltip clones its child
          and attaches its own hover props, which a plain `:hover` rule can't be clobbered by. */}
      <style>{`
        .pm-context-ring { display: inline-flex; border-radius: 50%; }
        .pm-context-ring:hover { background-color: var(--pm-hover-faint); }
      `}</style>
      <Tooltip title={t('chatView.contextRing.tooltip', { percent, used: inK(used), total: inK(total) })}>
        <span className="pm-context-ring">
          <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} style={{ display: 'block' }}>
            {/* The two strokes ride `style` rather than the presentation attributes:
                a `stroke="var(--x)"` attribute is not a CSS declaration everywhere,
                a `style` value always is. */}
            <circle cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none" strokeWidth={RING_STROKE} style={{ stroke: 'var(--pm-border)' }} />
            <circle
              cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none"
              strokeWidth={RING_STROKE} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={offset}
              transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
              style={{ transition: 'stroke-dashoffset 0.3s ease', stroke: 'var(--pm-text-secondary)' }}
            />
          </svg>
        </span>
      </Tooltip>
    </>
  )
}

/**
 * Estimate context usage for a message list: the last REAL request's priced
 * size (the `input_tokens` persisted on the message row, so the number
 * survives a restart) plus the tail appended since — priced through the nano
 * rules (`estimateAfterNanoTokens`), because that is how the next request
 * will carry it. Deliberately NOT the compactor's `contextTokensOf`: that
 * reader max-guards with the whole-transcript estimate, which is the copy
 * pipeline's trigger input and pins at >100% forever once the append-only
 * history outgrows the window — 775.2K shown against an 88K wire request
 * (conv_20260927170026, 2026-09-28). The two readers now measure different
 * quantities on purpose; the header of engine/context-estimate.ts carries the
 * full contract.
 */
export function estimateContextUsed(messages: AgentMessage[], contextLength?: number): number {
  if (!messages.length) return 0
  // Anchor + tail priced as the NEXT request would carry it: the tail's old
  // tool_results become nano placeholders before anything ships, and pricing
  // them raw over-read by exactly that share — a tool-heavy batch pinned the
  // ring at 79–96% mid-turn while the wire carried ~60%
  // (conv_20261021155951, 2026-10-24). estimateAfterNanoTokens computes
  // quotas/protection over the tail slice alone, so a young tail prices whole
  // (nano compresses nothing below quota anyway) and the reading never drops
  // under what the request will really ship.
  // `contextLength` is the FULL window even for the tail slice: the merged
  // fit gate compares the whole copy's usage to the window, which is why the
  // anchor `t` rides along as the baseline — without it the tail alone would
  // look small forever and the gate would never open (PLAN-nano-light-
  // trigger-merge W1). Absent window ⇒ gate closed ⇒ raw pricing, the
  // conservative direction this reader already documents.
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].inputTokens
    if (t && t > 0) return t + estimateAfterNanoTokens(messages.slice(i + 1), contextLength, t)
  }
  return estimateAfterNanoTokens(messages, contextLength)
}

/**
 * Context usage as the ring should show it AFTER a compaction pass. The live
 * history never shrinks — compaction operates on the outgoing API copy — so
 * the raw estimate would sit at 90% forever after the model is actually
 * seeing 40%. The compaction event carries the copy's measured size
 * (tokensAfter) at ts; everything appended after that moment is estimated on
 * top, giving a ring that drops the instant the event lands and then tracks
 * new turns from the compacted base. Any message without a timestamp (or no
 * event) falls back to the raw estimate.
 */
export function projectContextUsed(
  messages: AgentMessage[],
  compaction: CompactionEvent | null | undefined,
  contextLength?: number,
): number {
  const raw = estimateContextUsed(messages, contextLength)
  if (!compaction || !messages.length) return raw
  // ts is the engine's Date.now() at the pass; message createdAt is ISO from
  // the same main-process clock, so plain comparison orders them.
  if (typeof compaction.ts !== 'number' || !Number.isFinite(compaction.ts)) return raw
  const cutAt = compaction.ts
  const tailMsgs: AgentMessage[] = []
  for (const msg of messages) {
    const at = msg.createdAt ? Date.parse(msg.createdAt) : NaN
    if (!Number.isFinite(at)) return raw
    if (at > cutAt) tailMsgs.push(msg)
  }
  // Same nano pricing as the raw path — the tail's compressible results ride
  // the next request as placeholders, not whole — and the compacted copy's
  // measured size is the baseline the fit gate should judge against.
  const projected = compaction.tokensAfter + estimateAfterNanoTokens(tailMsgs, contextLength, compaction.tokensAfter)
  // Estimates drift upward as the tail grows; a projection above the raw
  // number would mean the "compacted" copy is bigger than the history — fall
  // back to the raw reading rather than show a ring that grew on compaction.
  return projected < raw ? projected : raw
}
