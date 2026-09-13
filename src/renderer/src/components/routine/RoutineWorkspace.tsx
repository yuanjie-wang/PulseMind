// ── Routine run workspace (PLAN-0.4.0 M4.3 revision) ──
// Three-pane run inspector entered from the card grid's 运行历史 action:
// task list · run history (latest selected by default) · the selected run's
// persisted conversation, rendered inline via the shared TranscriptView.

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Spin, Tag, Tooltip } from 'antd'
import { ArrowLeftOutlined, EditOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { TranscriptView } from '../chat/TranscriptView'
import { storedMessagesToAgentMessages } from '../../utils/message-utils'
import { describeRelativeTimeText } from '../../utils/relative-time'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { AgentMessage } from '../../types/agent'

export const RUN_STATUS_TAG: Record<RoutineRun['status'], { color?: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  skipped: { text: '已跳过' },
}

export interface RoutineWorkspaceProps {
  routines: Routine[]
  /** Task preselected when entering the workspace (the card that was clicked). */
  initialRoutineId: string
  onBack: () => void
  onEdit: (routine: Routine) => void
  onRunNow: (routine: Routine) => void
  /** Open the run's conversation full-size in the chat view. */
  onOpenConversation?: (conversationKey: string) => void
}

/** A settled read-only transcript: no approvals can arrive, so every gate
 *  callback is a no-op. */
const NOOP = (): void => {}

export function RoutineWorkspace({ routines, initialRoutineId, onBack, onEdit, onRunNow, onOpenConversation }: RoutineWorkspaceProps): React.ReactElement {
  const { t } = useTranslation()
  const [routineId, setRoutineId] = useState(initialRoutineId)
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [convLoading, setConvLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** When runs were fetched — render stays pure by not calling Date.now(). */
  const [runsFetchedAt, setRunsFetchedAt] = useState(0)

  const routine = routines.find((r) => r.id === routineId) ?? null
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null

  const loadConversation = useCallback(async (run: RoutineRun | null): Promise<void> => {
    if (!run?.conversationId) {
      setMessages([])
      return
    }
    setConvLoading(true)
    try {
      const conv = await window.electronAPI.getConversation(run.conversationId)
      setMessages(storedMessagesToAgentMessages(conv?.messages ?? []))
    } catch {
      setMessages([])
    } finally {
      setConvLoading(false)
    }
  }, [])

  /** Load a task's runs and select `preferRunId` when it is still present
   *  (refresh), else the newest run. */
  const openRuns = useCallback(async (id: string, preferRunId?: string): Promise<void> => {
    const list = await window.electronAPI.routineRuns(id, 30).catch(() => [] as RoutineRun[])
    setRuns(list)
    setRunsFetchedAt(Date.now())
    const next = (preferRunId ? list.find((r) => r.id === preferRunId) : undefined) ?? list[0] ?? null
    setSelectedRunId(next?.id ?? null)
    void loadConversation(next)
  }, [loadConversation])

  useEffect(() => { void openRuns(routineId) }, [routineId, openRuns])

  const refresh = (): void => {
    setRefreshing(true)
    void openRuns(routineId, selectedRunId ?? undefined).finally(() => setRefreshing(false))
  }

  const scheduleText = (r: Routine): string =>
    r.enabled ? (r.schedule ? '定时' : '手动') : '已停用'

  const emptyHint = convLoading
    ? ''
    : selectedRun?.conversationId ? '该记录没有保存对话内容。' : '该记录没有可回看的对话。'

  return (
    <div style={{ height: '100%', display: 'flex', background: '#fff', overflow: 'hidden' }}>
      {/* Left — task list */}
      <div style={{ width: 232, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '12px 12px 8px' }}>
          <Tooltip title="返回任务卡片">
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack} />
          </Tooltip>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>日常任务</span>
          <Tooltip title="立即运行当前任务">
            <Button type="text" size="small" icon={<PlayCircleOutlined />} disabled={!routine} onClick={() => routine && onRunNow(routine)} />
          </Tooltip>
          <Tooltip title="编辑当前任务">
            <Button type="text" size="small" icon={<EditOutlined />} disabled={!routine} onClick={() => routine && onEdit(routine)} />
          </Tooltip>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 12px' }}>
          {routines.map((r) => {
            const active = r.id === routineId
            return (
              <div
                key={r.id}
                onClick={() => setRoutineId(r.id)}
                style={{
                  padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                  background: active ? 'rgba(0,0,0,0.05)' : 'transparent',
                }}
              >
                <div style={{
                  fontSize: 13, fontWeight: active ? 600 : 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {r.name}
                </div>
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{scheduleText(r)}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Middle — run history of the selected task */}
      <div style={{ width: 300, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 14px 8px' }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>运行历史</span>
          <Tooltip title="刷新运行记录">
            <Button type="text" size="small" icon={refreshing ? <Spin size="small" /> : <ReloadOutlined />} onClick={refresh} />
          </Tooltip>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 10px 12px' }}>
          {runs.length === 0 && <div style={{ color: '#999', fontSize: 12, padding: '8px 4px' }}>还没有运行记录。</div>}
          {runs.map((run) => {
            const active = run.id === selectedRunId
            return (
              <div
                key={run.id}
                onClick={() => {
                  setSelectedRunId(run.id)
                  void loadConversation(run)
                }}
                style={{
                  padding: '9px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                  border: active ? '1px solid #d9d9d9' : '1px solid transparent',
                  background: active ? 'rgba(0,0,0,0.04)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Tag color={RUN_STATUS_TAG[run.status].color} style={{ marginInlineEnd: 0 }}>{RUN_STATUS_TAG[run.status].text}</Tag>
                  <span style={{ fontSize: 11, color: '#888' }}>{run.trigger === 'schedule' ? '定时' : '手动'}</span>
                  <span style={{ fontSize: 11, color: '#bbb', marginInlineStart: 'auto' }}>
                    {describeRelativeTimeText(run.startedAt, runsFetchedAt, t) ?? new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                {run.error && (
                  <div style={{
                    fontSize: 11, color: '#cf1322', marginTop: 4,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {run.error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Right — the selected run's conversation */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderBottom: '1px solid #f0f0f0' }}>
          {selectedRun ? (
            <>
              <Tag color={RUN_STATUS_TAG[selectedRun.status].color}>{RUN_STATUS_TAG[selectedRun.status].text}</Tag>
              <span style={{ fontSize: 12, color: '#888' }}>{selectedRun.trigger === 'schedule' ? '定时触发' : '手动触发'}</span>
              <span style={{ fontSize: 12, color: '#bbb' }}>{new Date(selectedRun.startedAt).toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              {convLoading && <Spin size="small" />}
              {selectedRun.conversationId && (
                <Button
                  type="link"
                  size="small"
                  onClick={() => onOpenConversation?.(selectedRun.conversationId!)}
                >
                  在聊天中打开
                </Button>
              )}
            </>
          ) : (
            <span style={{ fontSize: 12, color: '#999' }}>选择一次运行记录查看对话</span>
          )}
        </div>
        <TranscriptView
          messages={messages}
          agentStatus={{ status: 'idle' }}
          streamingBlocks={[]}
          isRequesting={false}
          restoring={convLoading}
          emptyHint={emptyHint}
          onApproveTool={NOOP}
          onRejectTool={NOOP}
          onKillTool={NOOP}
          onRespondToTool={NOOP}
          onClearError={NOOP}
          onRetry={NOOP}
        />
      </div>
    </div>
  )
}
