import React from 'react'
import { Tooltip } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import type { AgentMessage } from '../../types/agent'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import type { CacheHitRate } from '../../../../shared/agent-session/cache-hit-rate'
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

export function ContextRing({
  used,
  total,
  diameter,
  cacheHit,
  inputBudget,
  lastCompaction,
}: {
  used: number
  total: number
  diameter?: number
  cacheHit?: CacheHitRate
  inputBudget?: number
  /** 最近一次压缩 pass（与已压缩 chip 同源）。有才出「压缩策略」行。 */
  lastCompaction?: CompactionEvent | null
}): React.ReactElement | null {
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
  // ── 输入预算刻度（方案 A，user 2026-11-17 拍板）──────────────────────
  // 环的分母保持**总窗口** —— 那才是用户理解的「这个模型多大」——但引擎压缩
  // 用的是扣掉输出预留的输入侧窗口：200K 窗口下两者差 32K，环显示 84% 时压缩
  // 其实已经触发。刻度线画在引擎真正的边界上，让「才 84% 怎么就开始压缩」有个
  // 看得见的解释，而不是靠用户去猜预留是多少。
  // 只在 0 < budget < total 时画：等于 total 时刻度正落在顶点（无信息），大于
  // total 则说明宿主与本组件的口径不一致 —— 宁可不画，也不画一根与引擎不符的线。
  const tick = inputBudget != null && Number.isFinite(inputBudget) && inputBudget > 0 && inputBudget < total ? inputBudget / total : null
  // Both figures read in thousands, the unit the label is written in — DECIMAL
  // thousands: token windows are quoted by providers in round-decimal K
  // (this one is literally 150_000), so /1024 read the window as 146.5K and
  // broke the tooltip's own ratio against the percent beside it (2026-11-21
  // user catch「和刻度的 /1000 不一样吧」). Same unit as the model-facing
  // gauge and the stats row's formatTokenCount.
  const inK = (n: number) => `${(n / 1000).toFixed(1)}K`
  // 浮窗是 label/value 栅格（user 2026-11-21：一段文字 → 结构化展示）——
  // 一个指标一行，标签列放问题（上下文使用 / 输入预算 / 缓存命中），
  // 值列放答案。首行是标题行：百分数加重，用量/窗口跟在后面
  //（user 同日三刀「上下文使用 59% · 86.3K / 146.5K」，单独的「已用」行退役）。
  const rows: { label: string; value: React.ReactNode; hint?: string }[] = [
    { label: t('chatView.contextRing.title'), value: <span className="pct">{percent}%</span>, hint: `${inK(used)} / ${inK(total)}` },
  ]
  // 刻度行与环上那根线同条件：刻度不存在（无预算或口径不符）就不出现空行。
  if (tick != null) {
    rows.push({
      label: t('chatView.contextRing.budget'),
      value: inK(inputBudget as number),
      hint: t('chatView.contextRing.budgetHint', { percent: Math.round(tick * 100) }),
    })
  }
  // 缓存行缺席语义保持原样：没有计数 ≠ 0% 命中 —— sidecar-only 历史或不报
  // 缓存字段的供应商，缺席读成全 miss 恰好是反的，什么都不给比给零诚实。
  if (cacheHit && cacheHit.requestCount > 0) {
    rows.push({
      label: t('chatView.contextRing.cache'),
      value: `${Math.round(cacheHit.hitRate * 100)}%`,
      hint: t(cacheHit.reliable ? 'chatView.contextRing.cacheDetail' : 'chatView.contextRing.cacheTentative', {
        count: cacheHit.requestCount,
      }),
    })
  }
  // 压缩行只报结果，不报机制（user 2026-11-21 四刀：外层 chip 退役后这里
  // 是压缩信息唯一展示面；每策略一行的机制名+效果描述用户不必看，回到
  // 「压缩了多少条、释放多少」的计数形态）。droppedMessages 只计 light+hard
  //（nano 是 1:1 占位替换，不丢条数），释放量取 pass 前后的实测差；非
  // request 来源（prewarm / manual）的 pass 要到下一次请求构建才真正落
  // 副本，hint 说明，不把「已执行」说成「已生效」。
  if (lastCompaction) {
    const freedK = (Math.max(0, lastCompaction.tokensBefore - lastCompaction.tokensAfter) / 1000).toFixed(1)
    rows.push({
      label: t('chatView.contextRing.strategies'),
      value: t('chatView.contextRing.compacted', { dropped: lastCompaction.droppedMessages, freed: freedK }),
      hint: lastCompaction.source !== 'request' ? t('chatView.contextRing.strategiesPending') : undefined,
    })
  }

  return (
    <>
      {/* The hover disc is a CSS rule rather than mouse handlers: Tooltip clones its child
          and attaches its own hover props, which a plain `:hover` rule can't be clobbered by. */}
      <style>{`
        .pm-context-ring { display: inline-flex; border-radius: 50%; }
        .pm-context-ring:hover { background-color: var(--pm-hover-faint); }
        .pm-ctx-tip { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 14px; row-gap: 4px; align-items: baseline; width: 340px; }
        .pm-ctx-tip .k { opacity: 0.65; text-align: right; white-space: nowrap; }
        .pm-ctx-tip .v { font-variant-numeric: tabular-nums; }
        .pm-ctx-tip .pct { font-weight: 600; }
        .pm-ctx-tip .sub { opacity: 0.65; font-size: 12px; }
      `}</style>
      {/* 强调一律走 opacity 不走硬色：antd 浮窗底色随主题翻转，opacity 两主题都可读。
          overlayStyle 放宽 antd 默认的 250px 浮窗上限；栅格定宽 340px（含浮窗内边距
          恰好 ≤360）+ 值列 minmax(0,1fr)：长的策略名单在值列内自然换行，而不是
          被 max-content 轨道顶出浮窗边缘削角（en 五策略名单一行 ≈500px，给够了
          也会把浮窗撑成横幅，定宽换行才是对的形态）。 */}
      <Tooltip
        overlayStyle={{ maxWidth: 360 }}
        title={
          <div className="pm-ctx-tip">
            {rows.map((row) => (
              <React.Fragment key={row.label}>
                <span className="k">{row.label}</span>
                <span className="v">
                  {row.value}
                  {row.hint != null && (
                    <span className="sub">
                      {' · '}
                      {row.hint}
                    </span>
                  )}
                </span>
              </React.Fragment>
            ))}
          </div>
        }
      >
        <span className="pm-context-ring">
          <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} style={{ display: 'block' }}>
            {/* The two strokes ride `style` rather than the presentation attributes:
                a `stroke="var(--x)"` attribute is not a CSS declaration everywhere,
                a `style` value always is. */}
            <circle cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none" strokeWidth={RING_STROKE} style={{ stroke: 'var(--pm-border)' }} />
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={r}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
              style={{ transition: 'stroke-dashoffset 0.3s ease', stroke: 'var(--pm-text-secondary)' }}
            />
            {/* 刻度线画在环的外侧：压在填充弧上的话两者同色，什么都看不见。
                起点贴着描边外沿（+0.25 留抗锯齿余量），终点收在盒内 11.75 以内 ——
                到盒边会被抗锯齿抹掉（见 RING_INSET 的注释）。
                角度按 0% = 顶点算，与填充弧的 rotate(-90) 同一套约定，否则刻度会
                与指针起点对不齐。 */}
            {tick != null && (
              <line
                x1={RING_CENTER + (r + RING_STROKE / 2 + 0.25) * Math.cos(tick * 2 * Math.PI - Math.PI / 2)}
                y1={RING_CENTER + (r + RING_STROKE / 2 + 0.25) * Math.sin(tick * 2 * Math.PI - Math.PI / 2)}
                x2={RING_CENTER + (r + RING_STROKE / 2 + 1.5) * Math.cos(tick * 2 * Math.PI - Math.PI / 2)}
                y2={RING_CENTER + (r + RING_STROKE / 2 + 1.5) * Math.sin(tick * 2 * Math.PI - Math.PI / 2)}
                strokeWidth={1}
                strokeLinecap="butt"
                style={{ stroke: 'var(--pm-text-secondary)' }}
              />
            )}
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
export function projectContextUsed(messages: AgentMessage[], compaction: CompactionEvent | null | undefined, contextLength?: number): number {
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
