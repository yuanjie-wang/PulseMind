// ── Message action row narrow-column collapse (2026-10-31 user ruling,
//    stats arm reversed 2026-11-22「宽度不足时隐藏上下文信息」) ──
// In narrow chat columns the action buttons yield instead of wrapping,
// collapsing progressively into a ⋯ overflow menu:
//   ≥440px   all five inline + full stats (the old row untouched)
//   360–439  下载/点赞/存为任务 → ⋯ (inline 复制+收藏); the token
//            stats group (上下文信息) hides with them — the completion
//            timestamp is what stays
//   <360px   收藏 also → ⋯ (inline 复制+⋯; the chat column's floor is 320px)
// The mechanism is pure CSS container queries (global index.html) over
// always-mounted elements — no JS measurement, so like/favorite state can
// never desync between the inline button and its menu item. The Dropdown
// overlay mounts INSIDE the row so the same queries govern the menu items
// (the 收藏 item exists only in the narrowest tier). viewOnly hosts (two
// buttons, ~310px worst case) sit under the 320px column floor and never
// collapse: their row renders exactly as before.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(__dirname, '..')
const GROUP = join(REPO, 'src', 'renderer', 'src', 'components', 'chat', 'MessageGroup.tsx')
const INDEX_HTML = join(REPO, 'src', 'renderer', 'index.html')
const ZH = join(REPO, 'src', 'renderer', 'src', 'i18n', 'locales', 'zh.ts')
const EN = join(REPO, 'src', 'renderer', 'src', 'i18n', 'locales', 'en.ts')

/** Slice between a start marker and the next occurrence of `endMarker`. */
function blockOf(src: string, startMarker: string, endMarker: string): string {
  const from = src.indexOf(startMarker)
  expect(from).toBeGreaterThan(-1)
  const to = src.indexOf(endMarker, from + startMarker.length)
  return to > from ? src.slice(from, to) : src.slice(from)
}

describe('collapse CSS (global index.html)', () => {
  const css = readFileSync(INDEX_HTML, 'utf-8')

  it('the row is a size container and the ⋯ trigger defaults to hidden (wide tier)', () => {
    expect(css).toContain('container-type: inline-size')
    expect(css).toContain('.pm-msg-actions {')
    // The always-mounted pair starts on the wide-tier side: ⋯ hidden.
    expect(css).toContain('.pm-msg-overflow {')
  })

  it('tier 2 (≤439px): collapse set hides, ⋯ shows, token stats hide (2026-11-22)', () => {
    const tier2 = blockOf(css, '@container (max-width: 439px)', '@container (min-width: 360px)')
    expect(tier2).toContain('.pm-msg-actions .pm-msg-btn-collapse')
    expect(tier2).toContain('display: none !important')
    expect(tier2).toContain('.pm-msg-actions .pm-msg-overflow')
    expect(tier2).toContain('display: inline-flex !important')
    // 2026-11-22 user ruling「宽度不足时隐藏上下文信息」: the token group
    // yields in the same tier where the buttons first collapse.
    expect(tier2).toContain('.pm-msg-actions .pm-msg-stats-tokens')
    expect(tier2).toContain('display: none !important')
  })

  it('the 收藏 menu item is hidden from 360px up (tier-2 shows it inline already)', () => {
    const midTier = blockOf(css, '@container (min-width: 360px)', '@container (max-width: 359px)')
    expect(midTier).toContain('.pm-msg-actions .pm-msg-menu-fav')
    expect(midTier).toContain('display: none !important')
  })

  it('tier 3 (<360px): the inline 收藏 hides too', () => {
    const tier3 = blockOf(css, '@container (max-width: 359px)', '</style>')
    expect(tier3).toContain('.pm-msg-actions .pm-msg-btn-fav')
    expect(tier3).toContain('display: none !important')
  })

  it('every toggle carries !important — the buttons carry inline display:inline-flex', () => {
    // A plain stylesheet `display` loses to the inline style; the collapse
    // silently dies without the flag.
    const rules = css.slice(css.indexOf('.pm-msg-actions {'), css.indexOf('</style>'))
    const toggles = rules.match(/display: (none|inline-flex) !important/g) ?? []
    expect(toggles.length).toBeGreaterThanOrEqual(5)
  })
})

describe('collapse wiring (MessageGroup)', () => {
  const groupSrc = readFileSync(GROUP, 'utf-8')
  // 耗时/Token 措辞真源（review_20261103 中6 起）。
  const statsSrc = readFileSync(join(REPO, 'src', 'shared', 'ui', 'message-stats.ts'), 'utf-8')

  it('the row carries the container class', () => {
    expect(groupSrc).toContain('className="pm-msg-actions"')
  })

  it('the row stretches to the full column (probe-caught 2026-10-31)', () => {
    // The row is a flex item of the message column (alignItems: flex-start →
    // shrink-to-fit); container-type: inline-size hides the content from that
    // sizing, so without alignSelf:'stretch' the container collapses to 0px
    // wide and every @container query reads the narrowest tier — all buttons
    // hidden forever. scripts/probe-msg-actions-collapse.mjs caught it
    // (rowW:0); this byte pin keeps the fix from being "cleaned up".
    expect(groupSrc).toContain("alignSelf: 'stretch'")
  })

  it('the collapse classes land on the yielding buttons, the favorite keeps its own', () => {
    // 下载 only yields in the full variant — viewOnly hosts never collapse.
    expect(groupSrc).toContain("actions === 'full' ? 'pm-msg-btn-collapse' : undefined")
    expect(groupSrc).toContain('className="pm-msg-btn-collapse"\n                  data-testid="routine-extract"')
    expect(groupSrc).toContain('className="pm-msg-btn-fav"')
  })

  it('the ⋯ trigger is always mounted inside the full-variant fragment', () => {
    expect(groupSrc).toContain('className="pm-msg-overflow"')
    expect(groupSrc).toContain('data-testid="msg-actions-more"')
    const fullFrom = groupSrc.indexOf("{actions === 'full' && (")
    const overflowAt = groupSrc.indexOf('className="pm-msg-overflow"')
    expect(fullFrom).toBeGreaterThan(-1)
    expect(overflowAt).toBeGreaterThan(fullFrom)
    // Same fragment: the Dropdown closes it right after the trigger.
    expect(groupSrc.slice(overflowAt, overflowAt + 800)).toContain('</>')
  })

  it('the overlay mounts into the action row so @container reaches the menu items', () => {
    expect(groupSrc).toContain('getPopupContainer={(trigger) => trigger.parentElement ?? document.body}')
  })

  it('the menu mirrors the inline actions (like toggles, favorite is one-way, routine is conditional)', () => {
    // Same toggle the inline button performs — the metadata write appears on
    // both surfaces.
    expect(groupSrc.match(/updateMessageMetadata\(persistedMsgId, \{ liked: next \}\)/g)?.length).toBe(2)
    // One-way knowledge entry: already saved → disabled, never a second write.
    expect(groupSrc).toContain("label: favorited ? t('chatView.favorited') : t('chatView.favorite')")
    expect(groupSrc).toContain('disabled: favorited || savingFavorite')
    // The menu item is the one that hides in the middle tier.
    expect(groupSrc).toContain("className: 'pm-msg-menu-fav'")
    // Conversation-scoped entry: no callback → no menu item.
    expect(groupSrc).toContain('...(onExtractRoutine')
    expect(groupSrc).toContain("label: extractingRoutine ? t('chatView.routineExtracting') : t('chatView.saveAsRoutine')")
  })

  it('the ⋯ trigger: horizontal glyph, hover-open (2026-11-01 user ruling)', () => {
    // 横排三点，不是 MoreOutlined 的竖排 ⋮。
    expect(groupSrc).toContain('<EllipsisOutlined />')
    expect(groupSrc).not.toContain('MoreOutlined')
    // Hover opens the menu, like the conversation-row menus — no click needed.
    expect(groupSrc).toContain("trigger={['hover']}")
  })

  it('the stats line shows calendar stamps, not durations (2026-11-21 user ruling)', () => {
    // 耗时档位整个退役（scopes 混装：token 单请求、耗时整轮）——工具条改显
    // 完成时间戳（与用户气泡的发送时间同形）。formatDuration 在 shared 真源
    // 与两侧消费者中都不得残留。
    expect(statsSrc).not.toMatch(/formatDuration\b/)
    expect(groupSrc).toContain("from '../../../../shared/ui/message-stats'")
    expect(groupSrc).not.toMatch(/formatDuration\b/)
    expect(groupSrc).not.toContain('processingTime')
    // 完成时间戳走 describeSentAtText（与用户侧 describeSentAtText 同一格式化
    // 通道），不是第二个私有拷贝。
    expect(groupSrc).toContain('describeSentAtText(')
  })

  it('token counts past one thousand read in k (2026-11-01 user ruling)', () => {
    // 千位分隔的「12,345」比「12.3k」宽且读不出量级；1000 整也入档不分叉。
    expect(statsSrc).toContain('if (n >= 1000)')
    expect(statsSrc).toContain('toFixed(1)}k')
    // 旧 10k 阈值不得残留。
    expect(statsSrc).not.toContain('n >= 10_000')
  })

  it('the token stats group is the collapse participant, the timestamp is not (2026-11-22 user ruling)', () => {
    // 2026-11-22「宽度不足时隐藏上下文信息」: the leading divider + the three
    // token spans live in ONE pm-msg-stats-tokens wrapper (the CSS hides the
    // whole group — a bare divider must never survive alone), while the
    // completion timestamp and its own divider stay outside it and therefore
    // always visible.
    const statsFrom = groupSrc.indexOf('const stats = turnStats ?? msg')
    expect(statsFrom).toBeGreaterThan(-1)
    expect(groupSrc.slice(statsFrom - 400, statsFrom)).not.toContain('pm-msg-btn')
    expect(groupSrc.slice(statsFrom)).toContain('className="pm-msg-stats-tokens"')
    // The wrapper is conditional: token-less messages (no usage reporting)
    // render no leading divider at all, so nothing dangles before the time.
    const wrapperAt = groupSrc.indexOf('{hasTokens && (')
    expect(wrapperAt).toBeGreaterThan(statsFrom)
    expect(groupSrc.slice(wrapperAt, wrapperAt + 200)).toContain('pm-msg-stats-tokens')
    // The timestamp fragment sits outside the wrapper.
    const timeAt = groupSrc.indexOf('{doneAt && (')
    expect(timeAt).toBeGreaterThan(wrapperAt)
    expect(groupSrc.slice(wrapperAt, timeAt)).not.toContain('<time')
  })
})

describe('collapse i18n', () => {
  it('menu-only labels exist in both locales', () => {
    expect(readFileSync(ZH, 'utf-8')).toContain("moreActions: '更多操作'")
    expect(readFileSync(ZH, 'utf-8')).toContain("liked: '已点赞'")
    expect(readFileSync(EN, 'utf-8')).toContain("moreActions: 'More actions'")
    expect(readFileSync(EN, 'utf-8')).toContain("liked: 'Liked'")
  })
})
