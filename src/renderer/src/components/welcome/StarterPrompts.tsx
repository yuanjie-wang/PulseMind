// ── Starter prompts ──
// The 试试 row, shared by both welcome modes: a small label over a handful of
// prompt chips. Chat mode pairs it with the quick-entry band and project mode
// with the project picker, so a first-time user sees a concrete thing to ask
// for in either mode. The two call sites supply their own prompts — a project's
// are about its workspace — but the shape and the send handoff live here, once.
//
// 点一下就是发送（2026-11-04 用户裁定，与浏览器空态开场同一裁定）：这一行的
// 全部意义是把「不知道该问什么」的人一步带到跑起来的回合；先落草稿再要求按
// 第二次，等于把唯一的用途拆成两步。`onSend` 是宿主的发送通道（ChatView 的
// sendMessageAndPin）。没有它（未配置 API 密钥 → 没有 composer、也没有可发的
// 地方）整行不渲染——点不动的药丸比没有药丸更糟。

import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import { PromptChip } from '../chat/PromptChip'

export function StarterPrompts({ labels, onSend }: { labels: string[]; onSend?: (label: string) => void }): React.ReactElement | null {
  const { t } = useTranslation()
  if (!onSend) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('welcome.tryThese')}</span>
      {labels.map((label) => (
        <PromptChip key={label} label={label} onClick={() => onSend(label)} />
      ))}
    </div>
  )
}
