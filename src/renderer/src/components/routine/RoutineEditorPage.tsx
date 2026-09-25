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

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Modal, Tooltip } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, FormOutlined, ImportOutlined, LoadingOutlined, PlusOutlined, SaveOutlined, ScheduleOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { createLlmAdapter } from '../../llm'
import { extractRoutineFromConversation, type ExtractedRoutineDraft } from './routine-extract'
import { FormAssistColumn } from '../form-assist/FormAssistColumn'
import { buildFormAssistSystemPrompt, formAssistConversationId } from '../form-assist/form-assist'
import { discardAssistConversation, promoteAssistDraftToEntity } from '../form-assist/session-lifecycle'
import { useFormAssistSession } from '../form-assist/useFormAssistSession'
import { EDITOR_COLUMN_HEADER, EDITOR_LIST_WIDTH, EDITOR_SURFACE } from '../layout/editor-layout'
import { configToCron } from '../../utils/schedule-builder'
import { describeCron } from '../../utils/schedule-text'
import { RoutineForm } from './RoutineForm'
import { PANE_ROW_STYLES } from './pane-styles'
import { ROUTINE_ASSIST_SPEC, ROUTINE_ASSIST_ALLOWED_TOOLS, ROUTINE_ASSISTANT_PROFILE } from './routine-assist'
import { applyAssistantPatch, draftToRoutineInput, EMPTY_DRAFT, routineToDraft, validateDraft, draftScheduleFromCron } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'
import { draftFromTemplate, routineTemplateById } from './routine-templates'
import type { Routine } from '../../../../shared/types/routine'

export interface RoutineEditorPageProps {
  /** Routine loaded into the form; absent = the create-new flow. */
  routineId?: string
  /** Recommended template (routine-templates.ts) to prefill the create-new
   *  form with — the 推荐模板 half of the landing page links here this way.
   *  Ignored when `routineId` is set. */
  templateId?: string
  /** A draft distilled from a conversation (the chat toolbar's 存为日常任务,
   *  handed over as the `routineDraft` view param). Fills the create-new form
   *  once on mount; the user reviews — the schedule above all — and saves.
   *  Ignored when `routineId` is set. */
  routineDraft?: ExtractedRoutineDraft
}

function RoutineEditorPage({ routineId: routineIdProp, templateId, routineDraft }: RoutineEditorPageProps): React.ReactElement {
  const { modal } = AntdApp.useApp()
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const { settings, switchProfile, loading: settingsLoading } = useSettings()
  const [routines, setRoutines] = useState<Routine[]>([])
  /** Which stored routine the assistant conversation is bound to; null = the
   *  create-flow's draft slot. The first save PROMOTES the draft thread into
   *  the new routine's slot and re-binds (用户裁定 2026-09-20：每个任务最多
   *  关联一个会话), so the just-had context follows the routine. */
  const [boundId, setBoundId] = useState<string | null>(routineIdProp ?? null)
  /** Bumped whenever the bound thread is discarded (新会话 / a fresh create
   *  entry): the session hook re-restores empty under the same convId. */
  const [sessionReset, setSessionReset] = useState(0)
  /** IPC target: null = next save creates, otherwise updates. */
  const [updateId, setUpdateId] = useState<string | null>(routineIdProp ?? null)
  const [draft, setDraft] = useState<RoutineDraftState>(EMPTY_DRAFT)
  /** Unsaved-changes flag — drives the header's 未保存 marker and the
   *  discard confirmation (same contract as the expert editor). */
  const [dirty, setDirty] = useState(false)
  /** Undo frames for the assistant's auto-applied patches (user ruling
   *  2026-09-20): each apply captures the whole PRE-patch draft plus the
   *  dirty flag, so 撤销 restores the form byte-for-byte — no field-wise
   *  inverse of the cron/params merge is needed. */
  const [undoStack, setUndoStack] = useState<Array<{ draft: RoutineDraftState; dirty: boolean }>>([])
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractTarget, setExtractTarget] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string }>>([])

  const reload = useCallback(async (): Promise<void> => {
    try {
      setRoutines(await window.electronAPI.routineList())
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
          notify.warning('该任务已不存在，已切换到新建')
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
  }, [routineIdProp])

  // Template prefill (the landing page's 推荐模板 cards): fills the create-new
  // form so the user reviews and saves instead of typing from scratch — nothing
  // is created here. Waits for settings to land, because the copy the template
  // contributes (name / description / prompt / param labels) is locale-dependent
  // and the context answers with the default locale until settings load; the ref
  // then freezes the application, so a later locale switch cannot overwrite what
  // the user has edited.
  const templateAppliedRef = useRef(false)
  useEffect(() => {
    if (routineIdProp || templateAppliedRef.current || settingsLoading) return
    const template = routineTemplateById(templateId)
    templateAppliedRef.current = true
    if (!template) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming a one-shot navigation param, not derived state
    setDraft(draftFromTemplate(template, settings.locale === 'en' ? 'en' : 'zh'))
    setDirty(false)
    setBoundId(null)
    setUpdateId(null)
  }, [templateId, routineIdProp, settingsLoading, settings.locale])

  /** Both extraction entries land here — the editor's own 从对话提取 picker and
   *  the chat toolbar's 存为日常任务 (via the `routineDraft` view param): fill
   *  the create-new form, create mode. The schedule rides the same
   *  cron→friendly-fields path as a stored routine, so what the user reviews is
   *  the regular schedule editor, not a raw cron string. */
  const applyExtractedDraft = useCallback((result: ExtractedRoutineDraft): void => {
    setDraft({
      ...EMPTY_DRAFT,
      name: result.name,
      description: result.description,
      prompt: result.prompt,
      ...draftScheduleFromCron(result.cron),
      sourceConversationId: result.sourceConversationId,
    })
    setDirty(false)
    setBoundId(null)
    setUpdateId(null)
  }, [])

  // Draft handoff from the chat toolbar: same shape as the template prefill,
  // consumed once per mount. No settings wait — the draft's copy was written in
  // the extraction locale and never re-translated under the user's feet.
  const chatDraftAppliedRef = useRef(false)
  useEffect(() => {
    if (routineIdProp || chatDraftAppliedRef.current) return
    if (!routineDraft) return
    chatDraftAppliedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming a one-shot navigation param, not derived state
    applyExtractedDraft(routineDraft)
  }, [routineDraft, routineIdProp, applyExtractedDraft])

  const assistConvId = formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, boundId)

  /** 丢弃当前绑定的线程并重置会话视图 — the 新会话 core, shared with the
   *  expert editor (same ruling: one conversation per task, the old thread is
   *  discardable). Undo frames belong to the discarded thread and die too. */
  const discardBoundSession = useCallback((): void => {
    setUndoStack([])
    void discardAssistConversation(assistConvId).then(() => setSessionReset((n) => n + 1))
  }, [assistConvId])

  const assist = useFormAssistSession({
    convId: assistConvId,
    title: `[日常助手] ${draft.name.trim() || '新建任务'}`,
    spec: ROUTINE_ASSIST_SPEC,
    // D8: the prompt follows the settings locale — with the spec's labelEn /
    // rulesEn now present, an en locale gets the English system prompt.
    systemPrompt: buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC, settings.locale === 'en' ? 'en' : 'zh'),
    // D15/D16: the internal expert pack (identity) + host-side tool pin (D17).
    allowedTools: ROUTINE_ASSIST_ALLOWED_TOOLS,
    expertProfile: ROUTINE_ASSISTANT_PROFILE,
    resetKey: sessionReset,
    // 自动填入：every newly parsed patch lands in the form the moment its
    // reply lands. Unstable identity is safe — the hook's fire-once ledger
    // makes its effect's re-runs no-ops, and this closure always reads the
    // latest `draft`/`dirty` when a real patch fires.
    onPatch: (patch) => {
      setUndoStack((stack) => [...stack, { draft, dirty }])
      setDraft(applyAssistantPatch(patch, draft))
      setDirty(true)
    },
  })

  // 新建任务即新会话 (user ruling 2026-09-20): every entry into the create
  // flow lands on boundId null (startNew / 模板预填 / 从对话提取 / 失效回退),
  // and mounting straight into create mode is a create entry too — the draft
  // slot keeps no history across create flows. Unlike the expert editor this
  // page is not remounted per switch, so the transition itself is the trigger.
  useEffect(() => {
    if (boundId !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reset empties the undo stack (bails out when already empty) as part of one user-visible discard
    discardBoundSession()
  }, [boundId, discardBoundSession])

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

  const removeRoutine = (routine: Routine): void => {
    modal.confirm({
      title: `删除「${routine.name}」？`,
      content: '运行历史会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineDelete(routine.id)
        // The assistant thread dies with its routine — dispose the live
        // main-side session first or a stale engine would hold the context
        // (the expert editor does the same).
        await discardAssistConversation(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, routine.id))
        if (updateId === routine.id) startNew()
        void reload()
      },
    })
  }

  const save = async (): Promise<void> => {
    const error = validateDraft(draft)
    if (error) { notify.error(error); return }
    setSaving(true)
    try {
      const input = draftToRoutineInput(draft)
      const updated = updateId ? await window.electronAPI.routineUpdate(updateId, input) : null
      if (updateId && updated) {
        notify.success('已保存')
      } else {
        // No target yet, or the target was deleted from under us — create it
        // rather than report a save that did not happen.
        const created = await window.electronAPI.routineCreate(input)
        setUpdateId(created.id)
        // 升格 (user ruling 2026-09-20): the thread the assistant is currently
        // bound to becomes this routine's own conversation — re-persisted
        // under the routine's slot, the old slot discarded, then re-bind so
        // the convId switch re-restores from the new slot. Normal creates
        // promote the draft slot; the 另存为 rescue promotes the deleted
        // routine's slot. Either way the context follows the routine and the
        // one-conversation-per-routine invariant holds from birth. The prefix
        // (not `created.id`) names the target: the *slot* is what makes the row
        // the routine's assistant thread rather than a loose conversation.
        await promoteAssistDraftToEntity(
          assist.messages,
          ROUTINE_ASSIST_SPEC.conversationPrefix,
          assistConvId,
          created.id,
          `[日常助手] ${draft.name.trim() || '新建任务'}`,
        )
        setBoundId(created.id)
        if (updateId) notify.warning('原任务已不存在，已另存为新任务')
        else notify.success('已创建')
      }
      setDirty(false)
      void reload()
    } catch (err) {
      console.warn('[RoutineEditor] save failed:', err)
      notify.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** Live-form context appended to every assistant ask. The run-context fields
   *  ride along read-only: the assistant sees them (so its prose doesn't talk
   *  past the form) but the patch sanitizer never lets it set them. */
  const formSnapshot = (): Record<string, unknown> => ({
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    scheduleEnabled: draft.scheduleEnabled,
    cron: draft.scheduleEnabled ? configToCron(draft.sched) : '',
    catchUp: draft.catchUp,
    enabled: draft.enabled,
    params: draft.params,
    workspaceDir: draft.workspaceDir,
    approvalMode: draft.approvalMode,
    profileId: draft.profileId,
  })

  const askAssistant = (text: string): void => assist.send(text, formSnapshot())

  /** 撤销 the assistant's last auto-applied patch: restore the captured
   *  pre-patch frame. Manual edits made AFTER the apply are part of the
   *  applied state and go back with it — one click answers 「把刚填的撤掉」,
   *  and redo lives in the transcript (the content is still there verbatim). */
  const undoAssistantPatch = (): void => {
    const frame = undoStack[undoStack.length - 1]
    if (!frame) return
    setUndoStack((stack) => stack.slice(0, -1))
    setDraft(frame.draft)
    setDirty(frame.dirty)
    assist.clearAppliedPatch()
    notify.success(t('formAssist.undone'))
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
      const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
      if (!profile?.apiKey) {
        notify.error('请先在设置中配置 API Key')
        return
      }
      const result = await extractRoutineFromConversation(
        extractTarget,
        {
          adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
          apiKey: profile.apiKey,
          baseURL: profile.baseURL || '',
          model: profile.model || '',
        },
        settings.locale === 'en' ? 'en' : 'zh',
      )
      if (!result) {
        notify.warning('未能从该对话中提取出任务，试试另一个对话')
        return
      }
      setExtractOpen(false)
      applyExtractedDraft(result)
    } catch (err) {
      console.error('[RoutineEditor] extract failed:', err)
      notify.error('提取失败')
    } finally {
      setExtracting(false)
    }
  }

  const scheduleSummary = (routine: Routine): string =>
    routine.enabled
      ? routine.schedule ? `下次运行：${describeCron(routine.schedule.cron)}` : '手动执行'
      : '已停用'

  // Starter prompts for the assistant's empty state — the column renders them
  // as the app's shared starter-prompt pill (chat/PromptChip); a click sends.
  // D8: column copy rides i18n keys, same as the expert editor's.
  const assistExamples = [t('formAssist.routineExample1'), t('formAssist.routineExample2')]
  const assistIntro = t('formAssist.routineIntro')

  const canSave = draft.name.trim() !== '' && draft.prompt.trim() !== ''

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', gap: 12, padding: '0 24px 24px', boxSizing: 'border-box', background: 'var(--pm-bg)' }}>
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
                    fontSize: 13, fontWeight: active ? 600 : 400, color: routine.enabled ? 'var(--pm-text-strong)' : 'var(--pm-text-faint)',
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
            >
              保存
            </Button>
          </div>
          {/* paddingRight keeps the (auto-hiding) gutter clear of the form edge. */}
          <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
            <RoutineForm
              draft={draft}
              onChange={editDraft}
              appliedAssistantPatch={assist.appliedPatch}
              onUndoAssistantPatch={undoAssistantPatch}
              models={settings.profiles.map((p) => ({ id: p.id, name: p.name, providerName: p.providerName }))}
              activeModelId={settings.activeProfileId}
            />
          </div>
        </div>

        {/* ── Right: conversational form filler — the shared form-assist
            column (editor-layout white card + chat transcript + composer) ── */}
        <FormAssistColumn
          session={assist}
          title={t('formAssist.routineColumnTitle')}
          placeholder={t('formAssist.routinePlaceholder')}
          emptyIntro={assistIntro}
          emptyExamples={assistExamples}
          profiles={settings.profiles}
          activeProfileId={settings.activeProfileId}
          onSelectProfile={(profileId) => void switchProfile(profileId)}
          onSendMessage={askAssistant}
          onNewSession={discardBoundSession}
        />
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
                border: extractTarget === conv.id ? '1px solid var(--pm-text-strong)' : '1px solid var(--pm-border-hairline)',
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
