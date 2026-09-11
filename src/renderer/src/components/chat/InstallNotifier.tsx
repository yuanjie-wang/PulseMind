// ── Install success notifier ──
// PLAN-0.4.0 M2.3: when the agent installs a skill or MCP server during a
// conversation, surface a notification with a jump into the capability center
// tab it landed in, instead of burying the fact in a tool result block.

import React, { useEffect, useRef } from 'react'
import { App, Button } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import type { AgentMessage } from '../../types/agent'
import type { ToolResultBlock, ToolUseBlock } from '../../types/agent'

interface InstallNotifierProps {
  messages: AgentMessage[]
}

/** Extract (toolUse, result) pairs for `install` calls whose result has landed. */
function findCompletedInstalls(messages: AgentMessage[]): Array<{ use: ToolUseBlock; result: ToolResultBlock }> {
  const out: Array<{ use: ToolUseBlock; result: ToolResultBlock }> = []
  for (const msg of messages) {
    const blocks = msg.contentBlocks ?? []
    for (const block of blocks) {
      if (block.type !== 'tool_use' || block.name !== 'install') continue
      for (const other of blocks) {
        if (other.type === 'tool_result' && other.tool_use_id === block.id) {
          out.push({ use: block, result: other })
        }
      }
    }
  }
  return out
}

export function InstallNotifier({ messages }: InstallNotifierProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { notification } = App.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const notifiedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const { use, result } of findCompletedInstalls(messages)) {
      if (notifiedRef.current.has(use.id)) continue
      notifiedRef.current.add(use.id)
      if (result.is_error) continue

      const kind = String(use.input?.type ?? 'skill')
      const isMcp = kind === 'mcp'
      const key = `install-${use.id}`
      notification.success({
        message: isMcp ? t('install.installedMcp') : t('install.installedSkill'),
        description: String(use.input?.name ?? '') || undefined,
        key,
        duration: 6,
        btn: (
          <Button
            type="primary"
            size="small"
            onClick={() => {
              notification.destroy(key)
              navigate({ kind: 'capability', capabilityTab: isMcp ? 'mcp' : 'skills' })
            }}
          >
            {t('install.view')}
          </Button>
        )
      })
    }
  }, [messages, notification, navigate, t])

  return null
}
