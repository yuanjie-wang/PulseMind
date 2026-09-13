// ── Welcome page content ──
// Greeting + task form (the capsule switcher above drives chat/project mode via
// newTaskStore) + functional quick entries between it and the input:
// chat mode shows recent loose conversations and daily routines side by side;
// project mode shows the project cards (select target, jump to latest).

import React from 'react'
import { Typography, Button, Tooltip } from 'antd'
import { KeyOutlined, ArrowRightOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { WelcomeSuggestions } from '../welcome/WelcomeSuggestions'
import { ProjectCards } from '../welcome/ProjectCards'
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
const P2 = (SCROLL_DURATION * SCROLL_CYCLES / CYCLE_DURATION) * 100
/** The welcome view's quick band shares ONE height in both modes so switching
 *  对话/项目 never shifts the greeting. Width is the app's single content
 *  column — the composer's box and the chat message column are 952 too — so
 *  cards and input read as one aligned band instead of a narrow strip. */
const QUICK_AREA_HEIGHT = 224
const QUICK_AREA_MAX_WIDTH = 952

export function WelcomeContent({
  greeting,
  hasApiKey,
  animName,
  conversations,
  activeLoopConvIds = [],
  onOpenConversation
}: {
  greeting?: string | null
  hasApiKey: boolean
  animName: string
  conversations: ConversationListItem[]
  /** Conversations with a running loop get a status light in the recent list. */
  activeLoopConvIds?: string[]
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const mode = useNewTaskStore((s) => s.mode)

  return (
    <div style={{ textAlign: 'center', padding: '24px', margin: 'auto 0', width: '100%' }}>
      <style>{`@keyframes ${animName} {
        0%   { transform: translateX(0); }
        ${P1.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * 1}px); }
        ${P2.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
        100% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
      }`}</style>
      <div style={{ overflow: 'hidden', width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, margin: '0 auto 16px', borderRadius: 8 }}>
        <div style={{
          display: 'flex',
          fontSize: 0,
          lineHeight: 0,
          width: LOGO_SIZE_WIDTH * COPIES,
          animation: `${animName} ${CYCLE_DURATION}s linear infinite`
        }}>
          {Array.from({ length: COPIES }).map((_, i) => (
            <img key={i} src={pulsemindLogo} alt="" style={{ width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, flexShrink: 0, objectFit: 'cover' }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Typography.Title key={greeting || 'default-title'} level={2} style={{ margin: 0, animation: 'greetingIn 0.6s ease' }}>
            {greeting || t("welcome.title")}
          </Typography.Title>
        </div>
        <Tooltip title="此内容由AI生成">
          <InfoCircleOutlined style={{ fontSize: 12, color: '#bbb', cursor: 'help', marginTop: 4 }} />
        </Tooltip>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 16, maxWidth: 400, display: 'block', margin: '0 auto', marginBottom: 24, marginTop: 20 }}>
        {t('welcome.subtitle')}
        <Tooltip title={t('welcome.about')}>
          <ArrowRightOutlined
            style={{ marginLeft: 8, cursor: 'pointer', color: 'inherit', fontSize: 14 }}
            onClick={() => navigate({ kind: 'about' })}
          />
        </Tooltip>
      </Typography.Text>

      {/* Quick band: the assistant's proactive suggestions + starter prompts
          (chat mode), or the project picker (project mode). One shared fixed
          height keeps the greeting at the same Y in both modes. */}
      <div style={{ width: '100%', maxWidth: QUICK_AREA_MAX_WIDTH, margin: '0 auto', height: QUICK_AREA_HEIGHT, overflow: 'auto' }}>
        {mode === 'chat' ? (
          <WelcomeSuggestions
            activeLoopConvIds={activeLoopConvIds}
            onOpenConversation={onOpenConversation}
          />
        ) : (
          <ProjectCards conversations={conversations} onOpenConversation={onOpenConversation} />
        )}
      </div>

      {!hasApiKey && (
        <div style={{
          background: '#fff7e6',
          border: '1px solid #ffd591',
          borderRadius: 8,
          padding: '16px 24px',
          marginBottom: 24,
          maxWidth: 400,
          textAlign: 'center',
          display: 'inline-block'
        }}>
          <p style={{ margin: '0 0 12px', color: '#d46b08' }}>
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
