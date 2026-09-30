// ── Welcome page content ──
// Greeting + task form (the capsule switcher above drives chat/project mode via
// newTaskStore) + functional quick entries between it and the input:
// chat mode shows recent conversations and daily routines side by side;
// project mode shows the project cards (select target, jump to latest).

import React from 'react'
import { Typography, Button, Tooltip } from 'antd'
import { KeyOutlined, ArrowRightOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { WelcomeSuggestions } from '../welcome/WelcomeSuggestions'
import { ProjectCards } from '../welcome/ProjectCards'
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
}: {
  greeting?: string | null
  hasApiKey: boolean
  animName: string
  conversations: ConversationListItem[]
  /** Per-conversation sidebar light — the recent list's status lights. */
  convLights?: Record<string, ConversationLight>
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const mode = useNewTaskStore((s) => s.mode)

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
      <div data-welcome-logo style={{ overflow: 'hidden', width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, margin: '0 auto 16px', borderRadius: 8, flexShrink: 0 }}>
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
            <img key={i} src={pulsemindLogo} alt="" style={{ width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, flexShrink: 0, objectFit: 'cover', filter: 'var(--pm-logo-filter)' }} />
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
      <Typography.Text type="secondary" style={{ fontSize: 16, maxWidth: 400, display: 'block', margin: '0 auto', marginBottom: 24, marginTop: 20, flexShrink: 0 }}>
        {t('welcome.subtitle')}
        <Tooltip title={t('welcome.about')}>
          <ArrowRightOutlined style={{ marginLeft: 8, cursor: 'pointer', color: 'inherit', fontSize: 14 }} onClick={() => navigate({ kind: 'settings', settingsTab: 'about' })} />
        </Tooltip>
      </Typography.Text>

      {/* Quick band: fills the space down to the composer. Scrolling lives in
          each mode's content — the project picker renders its heading OUTSIDE
          its scroll region, so the scrollbar starts below the heading row. */}
      <div
        style={{
          width: '100%',
          maxWidth: QUICK_AREA_MAX_WIDTH + SCROLL_GUTTER,
          margin: '0 auto',
          flex: 1,
          minHeight: QUICK_AREA_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {mode === 'chat' ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div style={{ maxWidth: QUICK_AREA_MAX_WIDTH, margin: '0 auto' }}>
              <WelcomeSuggestions convLights={convLights} onOpenConversation={onOpenConversation} />
            </div>
          </div>
        ) : (
          <ProjectCards conversations={conversations} onOpenConversation={onOpenConversation} />
        )}
      </div>

      {!hasApiKey && (
        <div
          style={{
            background: 'var(--pm-warn-bg)',
            border: '1px solid var(--pm-warn-border)',
            borderRadius: 8,
            padding: '16px 24px',
            marginBottom: 24,
            maxWidth: 400,
            textAlign: 'center',
          display: 'inline-block',
          alignSelf: 'center',
          flexShrink: 0,
        }}
        >
          <p style={{ margin: '0 0 12px', color: 'var(--pm-warn)' }}>
            <KeyOutlined /> {t('welcome.noApiKey')}
          </p>
          <Button type="primary" onClick={() => navigate({ kind: 'settings', settingsTab: 'settings' })} icon={<KeyOutlined />}>
            {t('welcome.configureApiKey')}
          </Button>
        </div>
      )}
    </div>
  )
}
