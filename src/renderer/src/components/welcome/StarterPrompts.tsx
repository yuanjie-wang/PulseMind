// ── Starter prompts ──
// The 试试 row, shared by both welcome modes: a small label over a handful of
// prompt chips, one click each to drop the prompt into the composer. Chat mode
// pairs it with the quick-entry band and project mode with the project picker,
// so a first-time user sees a concrete thing to ask for in either mode. The two
// call sites supply their own prompts — a project's are about its workspace —
// but the shape and the draft-store handoff live here, once.

import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import { PromptChip } from '../chat/PromptChip'
import { useComposerDraftStore } from '../../stores/composerDraftStore'

export function StarterPrompts({ labels }: { labels: string[] }): React.ReactElement {
  const { t } = useTranslation()
  const setDraft = useComposerDraftStore((s) => s.setDraft)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 12, color: '#999' }}>{t('welcome.tryThese')}</span>
      {labels.map((label) => (
        <PromptChip key={label} label={label} onClick={() => setDraft(label)} />
      ))}
    </div>
  )
}
