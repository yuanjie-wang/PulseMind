// ── Routine editor page (PLAN-0.4.0 M4 revision) ──
// The create/edit flow as a dedicated page instead of a side drawer: routine
// list (the switcher) · form · assistant. Reached from the card grid's
// 新建任务 / 编辑 via `routineEditing` view params; the card grid keeps run
// history / 立即运行 / rich overviews.
//
// Layout follows the capability center's expert editor (see
// layout/editor-layout): the form and the assistant share one gray surface and
// the assistant sits inside it as a white card, so the conversation reads as an
// accessory of the form rather than a third peer column.

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Modal, Switch, Tooltip } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, FormOutlined, ImportOutlined, LoadingOutlined, PlusOutlined, RobotOutlined, SaveOutlined, ScheduleOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import { useSettings } from '../../hooks/SettingsContext'
import { createLlmAdapter } from '../../llm'
import { RoutineExtractionAgent } from '../../agent/one-shot-agent'
import { TranscriptView } from '../chat/TranscriptView'
import { InputArea } from '../chat/InputArea'
import { PromptChip } from '../chat/PromptChip'
import { EDITOR_CHAT_CARD, EDITOR_COLUMN_HEADER, EDITOR_LIST_WIDTH, EDITOR_SURFACE } from '../layout/editor-layout'
import { configToCron } from '../../utils/schedule-builder'
import { describeCron } from '../../utils/schedule-text'
import { RoutineForm } from './RoutineForm'
import { PANE_ROW_STYLES } from './pane-styles'
import { useRoutineAssistSession } from './useRoutineAssistSession'
import { buildFormAnnotation } from './routine-assist'
import type { RoutineFormSnapshot } from './routine-assist'
import { applyAssistantDraft, draftToRoutineInput, EMPTY_DRAFT, routineToDraft, validateDraft, draftScheduleFromCron } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'
import type { Routine } from '../../../../shared/types/routine'
import type { Project } from '../../../../shared/types/project'

export interface RoutineEditorPageProps {
  /** Routine loaded into the form; absent = the create-new flow. */
  routineId?: string
}

function RoutineEditorPage({ routineId: routineIdProp }: RoutineEditorPageProps): React.ReactElement {
  const { modal, message } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const { settings, switchProfile } = useSettings()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  /** Which stored routine the assistant conversation is bound to; null = the
   *  shared create-new draft bucket. Deliberately NOT bumped by a first save
   *  so the just-had conversation keeps its context. */
  const [boundId, setBoundId] = useState<string | null>(routineIdProp ?? null)
  /** IPC target: null = next save creates, otherwise updates. */
  const [updateId, setUpdateId] = useState<string | null>(routineIdProp ?? null)
  const [draft, setDraft] = useState<RoutineDraftState>(EMPTY_DRAFT)
  /** Unsaved-changes flag — drives the header's 未保存 marker and the
   *  discard confirmation (same contract as the expert editor). */
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractTarget, setExtractTarget] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string }>>([])

  const reload = useCallback(async (): Promise<void> => {
    try {
      setRoutines(await window.electronAPI.routineList())
      setProjects(await window.electronAPI.projectList())
    } catch (err) {
      console.warn('[RoutineEditor] load failed:', err)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, setState lands after await
  useEffect(() => { void reload() }, [reload])

  // Deep-link / param prefill: load the linked routine into the form.
  useEffect(() => {
    if (!routineIdProp) return
    let alive = true
    void (async () => {
      try {
        const routine = await window.electronAPI.routineGet(routineIdProp)
        if (!alive) return
        if (!routine) {
          // The id no longer resolves (deleted elsewhere, or a stale view param).
          // Sit on the create-new state instead of claiming 编辑任务 over a blank
          // form: saving would target a routine that is gone.
          setUpdateId(null)
          setBoundId(null)
          message.warning('该任务已不存在，已切换到新建')
          return
        }
        setDraft(routineToDraft(routine))
        setDirty(false)
        setBoundId(routine.id)
        setUpdateId(routine.id)
      } catch (err) {
        console.warn('[RoutineEditor] prefill failed:', err)
      }
    })()
    return () => { alive = false }
  }, [routineIdProp, message])

  const assist = useRoutineAssistSession({ routineId: boundId, projectId: draft.projectId, routineName: draft.name })

  /** Every user edit goes through here so the unsaved marker stays honest. */
  const editDraft = (next: RoutineDraftState): void => {
    setDraft(next)
    setDirty(true)
  }

  /** Run `action` right away when the form is clean, else ask first. */
  const confirmDiscard = (action: () => void): void => {
    if (!dirty) { action(); return }
    modal.confirm({
      title: '当前修改尚未保存',
      content: '离开将丢失未保存的修改。',
      okText: '丢弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: action,
    })
  }

  const startNew = (): void => {
    setDraft({ ...EMPTY_DRAFT })
    setDirty(false)
    setBoundId(null)
    setUpdateId(null)
  }

  const selectRoutine = (routine: Routine): void => {
    setDraft(routineToDraft(routine))
    setDirty(false)
    setBoundId(routine.id)
    setUpdateId(routine.id)
  }

  const goBack = (): void => confirmDiscard(() => navigate({ kind: 'routines' }))

  const toggleRoutine = (routine: Routine, checked: boolean): void => {
    void window.electronAPI.routineToggle(routine.id, checked).then(reload)
    // Keep the open form in sync so a later save does not revert the toggle.
    if (updateId === routine.id) setDraft((d) => ({ ...d, enabled: checked }))
  }

  const removeRoutine = (routine: Routine): void => {
    modal.confirm({
      title: `删除「${routine.name}」？`,
      content: '运行历史会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineDelete(routine.id)
        if (updateId === routine.id) startNew()
        void reload()
      },
    })
  }

  const save = async (): Promise<void> => {
    const error = validateDraft(draft)
    if (error) { message.error(error); return }
    setSaving(true)
    try {
      const input = draftToRoutineInput(draft)
      const updated = updateId ? await window.electronAPI.routineUpdate(updateId, input) : null
      if (updateId && updated) {
        message.success('已保存')
      } else {
        // No target yet, or the target was deleted from under us — create it
        // rather than report a save that did not happen.
        const created = await window.electronAPI.routineCreate(input)
        setUpdateId(created.id)
        if (updateId) message.warning('原任务已不存在，已另存为新任务')
        else message.success('已创建')
      }
      setDirty(false)
      void reload()
    } catch (err) {
      console.warn('[RoutineEditor] save failed:', err)
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** Live-form context appended to every assistant ask. */
  const formSnapshot = (): RoutineFormSnapshot => ({
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    scheduleEnabled: draft.scheduleEnabled,
    cron: draft.scheduleEnabled ? configToCron(draft.sched) : '',
    catchUp: draft.catchUp,
    enabled: draft.enabled,
    projectId: draft.projectId,
    params: draft.params,
  })

  const askAssistant = (text: string): void => assist.send(text, buildFormAnnotation(formSnapshot()))

  const applyProposal = (): void => {
    if (!assist.proposedDraft) return
    editDraft(applyAssistantDraft(assist.proposedDraft, draft))
    assist.clearProposedDraft()
    message.success('已应用助手草稿')
  }

  const openExtract = (): void => {
    setExtractTarget(null)
    setExtractOpen(true)
    void window.electronAPI.listConversations().then((list) => {
      setConversations(list.map((c) => ({ id: c.id, title: c.title })))
    }).catch(() => {})
  }

  const extractFromConversation = async (): Promise<void> => {
    if (!extractTarget) return
    setExtracting(true)
    try {
      const conv = await window.electronAPI.getConversation(extractTarget)
      const lines: string[] = []
      for (const msg of conv?.messages ?? []) {
        const text = (msg.contentBlocks ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')
        if (text) lines.push(`${msg.role === 'user' ? '用户' : '助手'}：${text}`)
      }
      const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
      if (!profile?.apiKey) {
        message.error('请先在设置中配置 API Key')
        return
      }
      const agent = new RoutineExtractionAgent()
      const draftResult = await agent.execute(
        { conversationText: lines.join('\n\n'), locale: settings.locale === 'en' ? 'en' : 'zh' },
        {
          llmConfig: {
            apiKey: profile.apiKey,
            baseURL: profile.baseURL || '',
            model: profile.model || '',
            adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
          },
        },
      )
      if (!draftResult) {
        message.warning('未能从该对话中提取出任务，试试另一个对话')
        return
      }
      setExtractOpen(false)
      setDraft({
        ...EMPTY_DRAFT,
        name: draftResult.name,
        description: draftResult.description,
        prompt: draftResult.prompt,
        ...draftScheduleFromCron(draftResult.cron),
        sourceConversationId: extractTarget,
      })
      setDirty(false)
      setBoundId(null)
      setUpdateId(null)
    } catch (err) {
      console.error('[RoutineEditor] extract failed:', err)
      message.error('提取失败')
    } finally {
      setExtracting(false)
    }
  }

  const scheduleSummary = (routine: Routine): string =>
    routine.enabled
      ? routine.schedule ? `下次运行：${describeCron(routine.schedule.cron)}` : '手动执行'
      : '已停用'

  // Starter prompts for the assistant's empty state — the app's shared
  // starter-prompt pill (chat/PromptChip), same as the expert editor, except a
  // click here sends the prompt.
  const assistExamples = [
    '每天早上九点检查 GitHub 通知，汇总成一份摘要',
    '每周五下午整理本周的工作记录，生成周报',
  ]
  const assistEmptyContent = (
    <div style={{ padding: '0 14px' }}>
      <div style={{ color: '#999', fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>
        描述你想自动化的工作，助手会帮你填写左侧表单；生成的草稿点「应用」才会写入。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {assistExamples.map((example) => (
          <PromptChip key={example} label={example} onClick={() => askAssistant(example)} />
        ))}
      </div>
    </div>
  )

  const canSave = draft.name.trim() !== '' && draft.prompt.trim() !== ''

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', gap: 12, padding: '0 24px 24px', boxSizing: 'border-box', background: '#fff' }}>
      <style>{PANE_ROW_STYLES}</style>

      {/* ── Left: routine list (also the switcher) ── */}
      <div style={{ width: EDITOR_LIST_WIDTH, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ ...EDITOR_COLUMN_HEADER, paddingTop: 12 }}>
          {/* Leaving the editor belongs with the list — it is the list column's
              own "back" affordance, not a form action. */}
          <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={goBack} style={{ marginLeft: -4 }}>
            返回
          </Button>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {!updateId && (
              <Tooltip title="从对话提取任务">
                <Button size="small" type="text" icon={<ImportOutlined />} onClick={openExtract} />
              </Tooltip>
            )}
            <Tooltip title="新建任务">
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => confirmDiscard(startNew)} />
            </Tooltip>
          </span>
        </div>
        <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {routines.length === 0 && (
            <div style={{ color: '#999', fontSize: 12, padding: '8px 10px' }}>还没有任务，点上方 + 新建。</div>
          )}
          {routines.map((routine) => {
            const active = updateId === routine.id
            return (
              <div
                key={routine.id}
                className={`pane-row${active ? ' pane-row--active' : ''}`}
                style={{ marginBottom: 2 }}
                onClick={() => { if (!active) confirmDiscard(() => selectRoutine(routine)) }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 16, textAlign: 'center', flexShrink: 0, color: routine.enabled ? '#888' : '#ccc' }}>
                    <ScheduleOutlined />
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontSize: 13, fontWeight: active ? 600 : 400, color: routine.enabled ? '#333' : '#bbb',
                  }}>
                    {routine.name}
                  </span>
                  <span className="pane-row-action" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      title="删除任务"
                      onClick={() => removeRoutine(routine)}
                    />
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, paddingLeft: 24 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: '#aaa' }}>
                    {scheduleSummary(routine)}
                  </span>
                  <Switch size="small" checked={routine.enabled} onChange={(checked) => toggleRoutine(routine, checked)} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Form + assistant on one gray surface ── */}
      <div style={EDITOR_SURFACE}>
        {/* ── Middle: the form ── */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={EDITOR_COLUMN_HEADER}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <FormOutlined />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {updateId ? '编辑任务' : '新建任务'}
              </span>
              {dirty && <span style={{ color: '#faad14', fontWeight: 400, flexShrink: 0 }}>· 未保存</span>}
            </span>
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!canSave}
              onClick={() => void save()}
              style={{ background: '#000', borderColor: '#000' }}
            >
              保存
            </Button>
          </div>
          {/* paddingRight keeps the (auto-hiding) gutter clear of the form edge. */}
          <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
            <RoutineForm
              draft={draft}
              onChange={editDraft}
              projects={projects}
              pendingAssistantDraft={assist.proposedDraft}
              onApplyAssistantDraft={applyProposal}
              onDismissAssistantDraft={assist.clearProposedDraft}
            />
          </div>
        </div>

        {/* ── Right: conversational form filler, as a white card ── */}
        <div style={EDITOR_CHAT_CARD}>
          <div style={EDITOR_COLUMN_HEADER}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RobotOutlined />
              任务助手
            </span>
          </div>
          <TranscriptView
            messages={assist.messages}
            agentStatus={assist.agentStatus}
            streamingBlocks={assist.streamingBlocks}
            isRequesting={assist.isBusy}
            restoring={assist.restoring}
            emptyContent={assist.restoring ? null : assistEmptyContent}
            contentInset={0}
            onApproveTool={(id) => assist.engineCall('approveTool', id)}
            onRejectTool={(id) => assist.engineCall('rejectTool', id)}
            onKillTool={(id) => assist.engineCall('killTool', id)}
            onRespondToTool={(id, response) => assist.engineCall('respondToTool', id, response)}
            onClearError={() => assist.engineCall('clearError')}
            onRetry={() => assist.engineCall('retryLastTurn')}
          />
          <InputArea
            layout="inline"
            isRequesting={assist.isBusy}
            isStreaming={assist.isBusy}
            isAwaitingApproval={assist.agentStatus.status === 'awaiting_approval'}
            isAwaitingInput={assist.agentStatus.status === 'awaiting_user_input'}
            hasMessages={assist.messages.length > 0}
            autoFocus={false}
            placeholder="描述你想自动化的工作…"
            onSendMessage={askAssistant}
            onCancel={assist.cancel}
            profiles={settings.profiles}
            activeProfileId={settings.activeProfileId}
            onSelectProfile={(profileId) => {
              // The engine rebuilds its options main-side; signal the session so
              // the next ask uses the newly selected model (same as run history).
              void switchProfile(profileId).then(() => assist.refreshOptions())
            }}
            features={{ modelPicker: true }}
          />
        </div>
      </div>

      {/* Extract-from-conversation picker */}
      <Modal
        title="从对话提取日常工作"
        open={extractOpen}
        onCancel={() => setExtractOpen(false)}
        onOk={() => void extractFromConversation()}
        okText={extracting ? '提取中…' : '提取'}
        okButtonProps={{ disabled: !extractTarget, icon: extracting ? <LoadingOutlined /> : undefined }}
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto' }}>
          {conversations.length === 0 && <div style={{ color: '#999' }}>没有可提取的对话。</div>}
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => setExtractTarget(conv.id)}
              style={{
                padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                border: extractTarget === conv.id ? '1px solid #333' : '1px solid #f0f0f0',
                background: extractTarget === conv.id ? 'rgba(0,0,0,0.04)' : 'transparent',
              }}
            >
              {conv.title}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}

export default RoutineEditorPage
