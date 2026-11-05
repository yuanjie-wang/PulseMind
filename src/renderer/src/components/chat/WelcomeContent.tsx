// ── Welcome page content ──
// Greeting + task form (the capsule switcher above drives chat/project/browser
// mode via newTaskStore) + functional quick entries between it and the input:
// chat mode shows recent conversations and daily routines side by side;
// project mode shows the project cards (select target, jump to latest);
// browser mode shows the URL entry + recent visits (PLAN-layout-modes 二期——
// 提交即物化浏览器任务，模式跟任务走)。

import React, { useEffect, useRef } from 'react'
import { Typography, Tooltip } from 'antd'
import { ArrowRightOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { WelcomeSuggestions } from '../welcome/WelcomeSuggestions'
import { ProjectCards } from '../welcome/ProjectCards'
import { BrowserTaskPanel } from '../welcome/BrowserTaskPanel'
import { ApiKeyGuide } from '../welcome/ApiKeyGuide'
import { useWelcomeShake, playWelcomeEnter } from '../../utils/welcome-shake'
import type { ConversationLight } from '../../hooks/useConversationEngine'
import type { ConversationListItem } from '../../types/conversation'
import pulsemindLogo from '../../assets/pulseMind-black.png'

const LOGO_SIZE_WIDTH = 120
const LOGO_SIZE_HEIGHT = 90
const SCROLL_CYCLES = 2
const SCROLL_DURATION = 2
const PAUSE_DURATION = 5
const CYCLE_DURATION = SCROLL_DURATION * SCROLL_CYCLES + PAUSE_DURATION
const COPIES = SCROLL_CYCLES + 1
const P1 = (SCROLL_DURATION / CYCLE_DURATION) * 100
const P2 = ((SCROLL_DURATION * SCROLL_CYCLES) / CYCLE_DURATION) * 100
/** The welcome view's quick band fills the column between the greeting and
 *  the composer — identical fill in both modes, so switching 对话/项目 never
 *  shifts the greeting; 224 is only the floor for short windows (the page
 *  scrolls then). Width is the app's single content column — the composer's
 *  box and the chat message column are 952 too — so cards and input read as
 *  one aligned band instead of a narrow strip. */
const QUICK_AREA_HEIGHT = 224
const QUICK_AREA_MAX_WIDTH = 952
/** Switcher-to-logo breathing room, elastic: flex-grow fills it from the
 *  column's spare height up to this cap, and basis 0 lets it collapse to zero
 *  before anything else gives way on a short window. Together with the
 *  switcher band's 8px and this root's 24px padding the MAXIMUM gap is
 *  168 — the same as the old fixed 144 + 24, so tall windows look unchanged
 *  while short ones shrink the blank instead of squeezing the logo. */
const TOP_SPACER_MAX = 136
/** Horizontal room the band reserves so its scrollbar thumb never sits on the
 *  cards' right edge; the 952 column stays centered inside it. An overlay
 *  thumb is ~10px wide, hence 24 (12px of clear space per side). */
const SCROLL_GUTTER = 24

export function WelcomeContent({
  greeting,
  hasApiKey,
  animName,
  conversations,
  convLights = {},
  onOpenConversation,
  onBrowserTaskStart,
  onStarterSend,
}: {
  greeting?: string | null
  hasApiKey: boolean
  animName: string
  conversations: ConversationListItem[]
  /** Per-conversation sidebar light — the recent list's status lights. */
  convLights?: Record<string, ConversationLight>
  onOpenConversation: (key: string) => void
  /** browser 模式的任务入口：URL 回车/点历史项（宿主铸容器会话 + 开页签）。
   *  必填（review_20261105 中1）：可选 + 空转函数兜底曾把接线缺口变成静默
   *  死提交——摆一个点了没反应的表单比不摆更糟，让 TS 兜住所有宿主。 */
  onBrowserTaskStart: (url: string) => void
  /** 试试 chips 的发送通道（2026-11-04 裁定：点一下即发送，不是落草稿）。
   *  缺省 = 整行不渲染（没有 API 密钥就没有可发的地方）。 */
  onStarterSend?: (text: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const mode = useNewTaskStore((s) => s.mode)
  // 项目模式已选项目 = 压缩形态（选中横条 + 试试 prompts，输入框已出现）：
  // band 高度让位给 composer，短窗口压缩不出垂直滚动条（browser 同规）。
  const projectId = useNewTaskStore((s) => s.projectId)
  // 无密钥时引导卡顶替了 composer 与 browser 的 URL 行：新建任务的两处引导
  // 摇晃（composer / browserUrl）都落在卡上——否则点「新建任务 ▸ 对话/浏览器」
  // 在这台机器上摇不到任何东西，而摇晃的空转是静默的（没有提示不等于没有问题）。
  // 有密钥时卡不挂载，ref.current 为 null，animate 的可选链即空转，不会串场。
  const guideShakeRef = useRef<HTMLDivElement | null>(null)
  useWelcomeShake('composer', guideShakeRef)
  useWelcomeShake('browserUrl', guideShakeRef)

  // 形态切换的一次性入场（2026-11-04 追加，用户裁定「项目的切换动效不错，
  // 对话和浏览器也加上」）：对话/项目/浏览器三档共用一条换形过渡——mode 变化
  // 即在快捷区 root 上播 220ms 淡入+位移，与项目形态的选中/更换同一配方
  // （playWelcomeEnter）。快捷区在换档时不卸载（只换内部面板），所以它是
  // 「原地换形」的稳定锚点；方向统一为 'below'（新面从下方浮入），'above'
  // 留给网格的向上展开，别把两套语义混起来。
  // **挂载首跑刻意不播**：从历史列表打开空会话、切回 welcome 视图都是新挂载，
  // 必须静止（probe-welcome-focus 钉住）；ref 闸门与 ProjectCards 的同一写法。
  // transform+opacity 不动布局，探针在 ≥300ms 后读到的都是落定位置。
  const bandRef = useRef<HTMLDivElement | null>(null)
  const bandMountedRef = useRef(false)
  useEffect(() => {
    if (!bandMountedRef.current) {
      bandMountedRef.current = true
      return
    }
    playWelcomeEnter(bandRef.current, 'below')
  }, [mode])

  return (
    <div style={{ textAlign: 'center', padding: '24px', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes ${animName} {
        0%   { transform: translateX(0); }
        ${P1.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * 1}px); }
        ${P2.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
        100% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
      }`}</style>
      {/* Elastic top gap: the column's spare height (half of it, capped at
          TOP_SPACER_MAX) is the blank under the switcher — it shrinks to zero
          on a short window, then the quick band's 224 floor holds and the
          region scrolls. The fixed elements below all carry flexShrink:0, so
          overflow can never squeeze the logo (their overflow:hidden would
          otherwise give them an automatic minimum of 0). The data hooks are
          probe-welcome-layout.mjs's measurement points. */}
      <div data-welcome-spacer style={{ flex: '1 1 0', maxHeight: TOP_SPACER_MAX, minHeight: 0 }} />
      <div
        data-welcome-logo
        style={{ overflow: 'hidden', width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, margin: '0 auto 16px', borderRadius: 8, flexShrink: 0 }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 0,
            lineHeight: 0,
            width: LOGO_SIZE_WIDTH * COPIES,
            animation: `${animName} ${CYCLE_DURATION}s linear infinite`,
          }}
        >
          {Array.from({ length: COPIES }).map((_, i) => (
            <img
              key={i}
              src={pulsemindLogo}
              alt=""
              style={{ width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, flexShrink: 0, objectFit: 'cover', filter: 'var(--pm-logo-filter)' }}
            />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', gap: 6, marginBottom: 8, flexShrink: 0 }}>
        <div style={{ maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Typography.Title key={greeting || 'default-title'} level={2} style={{ margin: 0, animation: 'greetingIn 0.6s ease' }}>
            {greeting || t('welcome.title')}
          </Typography.Title>
        </div>
        <Tooltip title="此内容由AI生成">
          <InfoCircleOutlined style={{ fontSize: 12, color: 'var(--pm-text-faint)', cursor: 'help', marginTop: 4 }} />
        </Tooltip>
      </div>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 16, maxWidth: 400, display: 'block', margin: '0 auto', marginBottom: 24, marginTop: 20, flexShrink: 0 }}
      >
        {t('welcome.subtitle')}
        <Tooltip title={t('welcome.about')}>
          <ArrowRightOutlined
            style={{ marginLeft: 8, cursor: 'pointer', color: 'inherit', fontSize: 14 }}
            onClick={() => navigate({ kind: 'settings', settingsTab: 'about' })}
          />
        </Tooltip>
      </Typography.Text>

      {/* Quick band: fills the space down to the composer. Scrolling lives in
          each mode's content — the project picker renders its heading OUTSIDE
          its scroll region, so the scrollbar starts below the heading row.
          browser 模式（PLAN-layout-modes 六期）：minHeight 0——短窗口时 band
          压缩、历史列表自己出滚动条，welcome 页绝不出现垂直滚动条。
          项目模式已选后（2026-11-04 两形态）：压缩横条 + prompts 本身就矮，
          输入框又占了下方空间——同样 minHeight 0 让位。 */}
      <div
        ref={bandRef}
        data-welcome-band
        style={{
          width: '100%',
          maxWidth: QUICK_AREA_MAX_WIDTH + SCROLL_GUTTER,
          margin: '0 auto',
          flex: 1,
          minHeight: mode === 'browser' || (mode === 'project' && !!projectId) ? 0 : QUICK_AREA_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {mode === 'chat' ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div style={{ maxWidth: QUICK_AREA_MAX_WIDTH, margin: '0 auto' }}>
              <WelcomeSuggestions convLights={convLights} onOpenConversation={onOpenConversation} onStarterSend={onStarterSend} />
            </div>
          </div>
        ) : mode === 'browser' ? (
          // 浏览器面板恒挂、按密钥门禁（2026-11-04 用户裁定改口「输出框还是
          // 要显示的，只是禁用」）：此前的「未配置密钥整块退场」把 URL 行也
          // 撤了，welcome 只剩一张密钥卡，用户看不出这个形态本来能做什么。
          // 现在 URL 输入框与打开钮 disabled、历史行不可点（面板自己收指针/
          // hover），下方密钥卡给出去处。
          <BrowserTaskPanel disabled={!hasApiKey} onBrowserTaskStart={onBrowserTaskStart} />
        ) : (
          <ProjectCards conversations={conversations} onOpenConversation={onOpenConversation} onStarterSend={onStarterSend} />
        )}
      </div>

      {/* 未配置密钥的引导卡（2026-11-04 用户裁定重设计）：占 composer 原来的
          位置——密钥是对话的前提，输入框已由宿主按 hasApiKey 撤下（ChatView
          welcome 分支），这里给出去处。卡本身见 ApiKeyGuide（与 dock 窄面
          共用一份）。 */}
      {!hasApiKey && (
        <div ref={guideShakeRef} data-welcome-shake="apiKeyGuide" style={{ alignSelf: 'center', width: '100%', maxWidth: 560, flexShrink: 0, marginBottom: 8 }}>
          <ApiKeyGuide />
        </div>
      )}
    </div>
  )
}
