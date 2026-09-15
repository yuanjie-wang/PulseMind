import React, { useCallback, useMemo, useRef, useState } from 'react'
import { createLlmAdapter } from '../../../llm'
import {
  ExpertFormAgent,
  isDraftEmpty,
  type ExpertChatMessage,
  type ExpertFormDraft,
} from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'
import { useSettings } from '../../../hooks/SettingsContext'
import { InputArea } from '../../chat/InputArea'
import { PromptChip } from '../../chat/PromptChip'
import { TranscriptView } from '../../chat/TranscriptView'
import type { AgentMessage, AgentStatus, ContentBlock } from '../../../types/agent'
import type { LlmUsage } from '../../../llm/stream-types'

/** Stable empty tail for TranscriptView — a fresh array would invalidate its
 *  segment memo on every render. */
const NO_STREAMING_BLOCKS: ContentBlock[] = []

/** One turn of the visible thread; `applied` marks turns that patched the form,
 *  the rest is what the action row reports under the reply. */
interface Turn extends ExpertChatMessage {
  applied?: boolean
  processingMs?: number
  inputTokens?: number
  outputTokens?: number
}

export interface ExpertChatPanelProps {
  /** Live form values — read at send time so hand edits reach the model too. */
  getDraft: () => ExpertFormDraft
  /** Merge an assistant-proposed patch into the form. */
  onApplyDraft: (draft: ExpertFormDraft) => void
  locale: string
}

/**
 * Right column of the expert editor: the user describes the expert in prose and
 * the assistant answers with a form patch, which is merged into the middle
 * column via onApplyDraft. The thread renders through the chat's own transcript
 * (chat/TranscriptView) and composer (chat/InputArea) rather than a second
 * conversation UI — including its status affordances (in-flight is the
 * transcript's own cursor, a failed turn its own error card) and its action row,
 * which reports the call's duration and tokens. Nothing here is persisted, so
 * the row drops the two buttons that would write message metadata. Switching
 * experts remounts this panel (see ExpertSettings' per-session key), so a new
 * expert starts a fresh thread.
 */
export default function ExpertChatPanel({
  getDraft,
  onApplyDraft,
  locale,
}: ExpertChatPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const { settings, switchProfile } = useSettings()
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agentRef = useRef(new ExpertFormAgent())

  // The applied marker is display-only: the model reads `turns`, not this.
  const messages = useMemo(
    (): AgentMessage[] =>
      turns.map((turn, i) => ({
        id: `expert-turn-${i}`,
        role: turn.role,
        createdAt: new Date().toISOString(),
        processingMs: turn.processingMs,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        contentBlocks: [
          {
            type: 'text',
            text: turn.applied ? `${turn.content}\n\n*${t('expertCenter.chatApplied')}*` : turn.content,
          },
        ],
      })),
    [turns, t],
  )

  /**
   * One turn against the model. `history` is what the thread held before this
   * turn, so a retry re-runs the same turn instead of appending a second copy
   * of the user message.
   */
  const runTurn = useCallback(
    async (history: ExpertChatMessage[], content: string): Promise<void> => {
      setBusy(true)
      setError(null)
      const startedAt = Date.now()
      let usage: LlmUsage | undefined

      try {
        const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0]
        if (!profile?.apiKey) {
          setError(t('expertCenter.chatNoProfile'))
          return
        }

        const result = await agentRef.current.execute(
          {
            draft: getDraft(),
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
            onUsage: (u) => {
              usage = u
            },
          }
        )

        const applied = !isDraftEmpty(result.draft)
        if (applied) onApplyDraft(result.draft)
        const reply = result.text || (applied ? t('expertCenter.chatApplied') : '')
        if (!reply) {
          setError(t('expertCenter.chatFailed'))
        } else {
          setTurns((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: reply,
              applied,
              processingMs: Date.now() - startedAt,
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
            },
          ])
        }
      } catch (err) {
        console.error('[ExpertChatPanel] assistant failed:', err)
        setError(t('expertCenter.chatFailed'))
      } finally {
        setBusy(false)
      }
    },
    [getDraft, locale, onApplyDraft, settings, t]
  )

  const send = useCallback(
    (text: string): void => {
      const content = text.trim()
      if (!content || busy) return
      const history: ExpertChatMessage[] = turns.map((turn) => ({ role: turn.role, content: turn.content }))
      setTurns((prev) => [...prev, { role: 'user', content }])
      void runTurn(history, content)
    },
    [busy, runTurn, turns]
  )

  /** The transcript's error card retries the turn that failed — its user message
   *  is already in the thread, so only the model call repeats. */
  const retry = useCallback((): void => {
    const idx = turns.map((turn) => turn.role).lastIndexOf('user')
    if (idx < 0) return
    const history: ExpertChatMessage[] = turns
      .slice(0, idx)
      .map((turn) => ({ role: turn.role, content: turn.content }))
    void runTurn(history, turns[idx].content)
  }, [runTurn, turns])

  const clearError = useCallback((): void => setError(null), [])

  const examples = [t('expertCenter.chatExample1'), t('expertCenter.chatExample2')]
  const noop = useCallback((): void => {}, [])

  // Empty state lives inside the transcript so the intro and the starter chips
  // are one block in one scroll area, not two stacked containers. The chips are
  // the app's shared starter-prompt pill (chat/PromptChip) — the same affordance
  // the welcome page offers, except a click here sends instead of prefilling.
  const emptyContent = (
    <div style={{ padding: '0 14px' }}>
      <div style={{ color: '#999', fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>{t('expertCenter.chatIntro')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {examples.map((ex) => (
          <PromptChip key={ex} label={ex} onClick={() => send(ex)} />
        ))}
      </div>
    </div>
  )

  // A failed turn is reported through the transcript's own error card, so the
  // status the chat's components already understand is the whole panel state:
  // 'error' while a failure stands, 'idle' otherwise. In-flight needs no status
  // at all — TranscriptView's cursor follows isRequesting.
  const agentStatus: AgentStatus = error ? { status: 'error', error } : { status: 'idle' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <TranscriptView
        messages={messages}
        agentStatus={agentStatus}
        streamingBlocks={NO_STREAMING_BLOCKS}
        isRequesting={busy}
        restoring={false}
        emptyContent={turns.length === 0 && !busy ? emptyContent : null}
        actions="viewOnly"
        contentInset={0}
        onApproveTool={noop}
        onRejectTool={noop}
        onKillTool={noop}
        onRespondToTool={noop}
        onClearError={clearError}
        onRetry={retry}
      />

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
        onSendMessage={send}
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
