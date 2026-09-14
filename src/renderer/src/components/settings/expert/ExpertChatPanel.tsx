import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { createLlmAdapter } from '../../../llm'
import {
  ExpertFormAgent,
  isDraftEmpty,
  type ExpertChatMessage,
  type ExpertFormDraft,
  type KnowledgeOption,
} from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'
import { useSettings } from '../../../hooks/SettingsContext'
import { InputArea } from '../../chat/InputArea'
import { TranscriptView } from '../../chat/TranscriptView'
import type { AgentMessage, ContentBlock } from '../../../types/agent'

/** Stable empty tail for TranscriptView — a fresh array would invalidate its
 *  segment memo on every render. */
const NO_STREAMING_BLOCKS: ContentBlock[] = []

/** One turn of the visible thread; `applied` marks turns that patched the form. */
interface Turn extends ExpertChatMessage {
  applied?: boolean
}

export interface ExpertChatPanelProps {
  /** Live form values — read at send time so hand edits reach the model too. */
  getDraft: () => ExpertFormDraft
  /** Merge an assistant-proposed patch into the form. */
  onApplyDraft: (draft: ExpertFormDraft) => void
  knowledgeFiles: KnowledgeOption[]
  locale: string
}

/**
 * Right column of the expert editor: the user describes the expert in prose and
 * the assistant answers with a form patch, which is merged into the middle
 * column via onApplyDraft. The thread renders through the chat's own transcript
 * (chat/TranscriptView) and composer (chat/InputArea) rather than a second
 * conversation UI — the turns are synthetic and nothing is persisted, so the
 * assistant action row stays off. Switching experts remounts this panel (see
 * ExpertSettings' per-session key), so a new expert starts a fresh thread.
 */
export default function ExpertChatPanel({
  getDraft,
  onApplyDraft,
  knowledgeFiles,
  locale,
}: ExpertChatPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const { settings, switchProfile } = useSettings()
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const agentRef = useRef(new ExpertFormAgent())

  // The applied marker is display-only: the model reads `turns`, not this.
  const messages = useMemo(
    (): AgentMessage[] =>
      turns.map((turn, i) => ({
        id: `expert-turn-${i}`,
        role: turn.role,
        createdAt: new Date().toISOString(),
        contentBlocks: [
          {
            type: 'text',
            text: turn.applied ? `${turn.content}\n\n*${t('expertCenter.chatApplied')}*` : turn.content,
          },
        ],
      })),
    [turns, t],
  )

  const send = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim()
      if (!content || busy) return
      const history: ExpertChatMessage[] = turns.map((turn) => ({ role: turn.role, content: turn.content }))
      setTurns((prev) => [...prev, { role: 'user', content }])
      setBusy(true)
      setHint(null)

      try {
        const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0]
        if (!profile?.apiKey) {
          setHint(t('expertCenter.chatNoProfile'))
          return
        }

        const result = await agentRef.current.execute(
          {
            draft: getDraft(),
            knowledgeFiles,
            history,
            message: content,
            locale,
          },
          {
            llmConfig: {
              adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
              apiKey: profile.apiKey,
              baseURL: profile.baseURL || '',
              model: profile.model || '',
            },
            maxTokens: 4096,
          }
        )

        const applied = !isDraftEmpty(result.draft)
        if (applied) onApplyDraft(result.draft)
        const reply = result.text || (applied ? t('expertCenter.chatApplied') : '')
        if (!reply) {
          setHint(t('expertCenter.chatFailed'))
        } else {
          setTurns((prev) => [...prev, { role: 'assistant', content: reply, applied }])
        }
      } catch (err) {
        console.error('[ExpertChatPanel] assistant failed:', err)
        setHint(t('expertCenter.chatFailed'))
      } finally {
        setBusy(false)
      }
    },
    [busy, getDraft, knowledgeFiles, locale, onApplyDraft, settings, t, turns]
  )

  const examples = [t('expertCenter.chatExample1'), t('expertCenter.chatExample2')]
  const noop = useCallback((): void => {}, [])

  // Empty state lives inside the transcript so the intro and the starter chips
  // are one block in one scroll area, not two stacked containers.
  const emptyContent = (
    <div style={{ padding: '0 14px' }}>
      <div style={{ color: '#999', fontSize: 13, lineHeight: 1.7 }}>{t('expertCenter.chatIntro')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {examples.map((ex) => (
          <Button
            key={ex}
            size="small"
            onClick={() => void send(ex)}
            style={{ textAlign: 'left', height: 'auto', whiteSpace: 'normal', padding: '6px 10px', fontSize: 12 }}
          >
            {ex}
          </Button>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <TranscriptView
        messages={messages}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={NO_STREAMING_BLOCKS}
        isRequesting={busy}
        restoring={false}
        emptyContent={turns.length === 0 && !busy ? emptyContent : null}
        showActions={false}
        onApproveTool={noop}
        onRejectTool={noop}
        onKillTool={noop}
        onRespondToTool={noop}
        onClearError={noop}
        onRetry={noop}
      />

      {(hint || busy) && (
        <div style={{ fontSize: 11, color: hint ? '#d4380d' : '#999', margin: '0 2px 6px' }}>
          {hint ?? t('expertCenter.chatThinking')}
        </div>
      )}

      {/* The one-shot call has no abort path, so the stop button has nothing to
          call — isRequesting still gives the in-flight feedback (spinner, and a
          send button that cannot double-submit). */}
      <InputArea
        layout="inline"
        isRequesting={busy}
        isStreaming={busy}
        isAwaitingApproval={false}
        isAwaitingInput={false}
        hasMessages={turns.length > 0}
        autoFocus={false}
        onSendMessage={(content) => void send(content)}
        onCancel={noop}
        placeholder={t('expertCenter.chatPlaceholder')}
        profiles={settings.profiles}
        activeProfileId={settings.activeProfileId}
        onSelectProfile={(profileId) => void switchProfile(profileId)}
        features={{ modelPicker: true }}
      />
    </div>
  )
}
