// ── 任务分步向导（P3 任务中心，user 2026-11-08 裁定）──
// routine 与 workflow 共用的唯一编辑器：4 步自由跳转、独立编辑，两种模式
// 只有「任务内容」步骤分叉（prompt 表单 vs 节点画布）。助手栏是**页面级
// 并列卡**（不在编辑面板里）：它贯穿全部四步，两种 kind 共用同一个
// FormAssistColumn ——只有 spec/会话槽按 kind 分叉（user 2026-11-08：
// 「两个任务助手要统一……样式以对话式任务的为准」）。两个会话实例都常驻
// 挂载、以 convId=null 休眠（useFormAssistSession 的休眠契约），同一时刻
// 只有当前 kind 那一条活着。保存/预填/交接/升级路径逐字节沿用两个旧编辑器
// 的：
// - routine：validateDraft → draftToRoutineInput → routineCreate/Update +
//   助手线程 promote（自 RoutineEditorPage 整体迁入）；
// - workflow：normalizeSimpleWorkflow → validateWorkflow → save（自
//   WorkflowCanvasPage 迁入）。
// 存储双轨不动：两个 kind 各写各的 store，本页只是壳。

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Radio, Segmented, Tooltip } from 'antd'
import { ArrowLeftOutlined, FormOutlined, ImportOutlined, LoadingOutlined, RobotOutlined, SaveOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { WORKFLOW_TASKS_UI } from '../../feature-flags'
import { notify } from '../../utils/notify'
import { createLlmAdapter } from '../../llm'
import { extractRoutineFromConversation, type ExtractedRoutineDraft } from './routine-extract'
import { FormAssistColumn } from '../form-assist/FormAssistColumn'
import { buildFormAssistSystemPrompt, formAssistConversationId } from '../form-assist/form-assist'
import { discardAssistConversation, promoteAssistDraftToEntity } from '../form-assist/session-lifecycle'
import { useFormAssistSession } from '../form-assist/useFormAssistSession'
import { EDITOR_CARD_SURFACE } from '../layout/editor-layout'
import { clampWizardAssistWidth, COLUMN_DRAG_HANDLE_WIDTH, WIZARD_ASSIST_DEFAULT_WIDTH } from '../../../../shared/ui/layout-widths'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { configToCron } from '../../utils/schedule-builder'
import { ParamsSection, PromptContentSection, ScheduleSection, BatchSection, TriggersSection, TaskRunContextFields, VariableSection } from './RoutineForm'
import type { VariableRow } from './RoutineForm'
import { WorkflowCanvas, blankWorkflow } from './WorkflowCanvas'
import { ROUTINE_ASSIST_SPEC, ROUTINE_ASSIST_ALLOWED_TOOLS, ROUTINE_ASSISTANT_PROFILE } from './routine-assist'
import {
  WORKFLOW_ASSIST_SPEC,
  WORKFLOW_ASSIST_ALLOWED_TOOLS,
  WORKFLOW_ASSISTANT_PROFILE,
  applyWorkflowAssistantPatch,
  workflowFormSnapshot,
} from './workflow-assist'
import { applyAssistantPatch, draftToRoutineInput, EMPTY_DRAFT, routineToDraft, validateDraft, draftScheduleFromCron } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'
import { draftFromTemplate, routineTemplateById } from './routine-templates'
import { autoWorkflowLayout } from '../../../../shared/workflow/layout'
import { validateWorkflow } from '../../../../shared/workflow/validate'
import { normalizeSimpleWorkflow } from '../../../../shared/workflow/simplify'
import type { WorkflowDefinition } from '../../../../shared/workflow/types'

export type TaskKind = 'routine' | 'workflow'

const STEP_ORDER = ['basics', 'content', 'runctx', 'trigger'] as const
type WizardStep = (typeof STEP_ORDER)[number]

/** 步骤卡 ↔ 助手栏的间距。分隔条骑在这条缝的正中，clamp 的上限也要扣掉它
 *  （可用宽度 = 行内容宽 − 这个 gap），所以它必须是常量而不是行内字面量。 */
const WIZARD_ROW_GAP = 12

/** One undo frame per applied assistant patch. Tagged by kind: both sessions
 *  live in the same stack, and a Ctrl-Z must never restore the OTHER kind's
 *  state into the form (switching kinds clears the stack outright). */
type UndoFrame = { kind: 'routine'; draft: RoutineDraftState; dirty: boolean } | { kind: 'workflow'; def: WorkflowDefinition; dirty: boolean }

export interface TaskWizardPageProps {
  kind: TaskKind
  /** routine 编辑目标；absent = 新建。 */
  routineId?: string
  /** 推荐模板预填（routine 新建）。 */
  templateId?: string
  /** 对话工具条「存为日常任务」交接的草稿（一次消费）。 */
  routineDraft?: ExtractedRoutineDraft
  /** workflow 编辑目标；absent = 新建。 */
  workflowId?: string
}

export function TaskWizardPage({ kind: kindProp, routineId, templateId, routineDraft, workflowId }: TaskWizardPageProps): React.ReactElement {
  const { modal, message } = AntdApp.useApp()
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const { settings, switchProfile, loading: settingsLoading } = useSettings()
  const models = settings.profiles.map((p) => ({ id: p.id, name: p.name, providerName: p.providerName }))
  const activeModelId = settings.activeProfileId

  const [kind, setKind] = useState<TaskKind>(kindProp)
  const [step, setStep] = useState<WizardStep>('basics')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // ── routine 分支（自 RoutineEditorPage 迁入，逻辑不变） ──
  const [boundId, setBoundId] = useState<string | null>(kindProp === 'routine' ? (routineId ?? null) : null)
  const [sessionReset, setSessionReset] = useState(0)
  const [updateId, setUpdateId] = useState<string | null>(kindProp === 'routine' ? (routineId ?? null) : null)
  const [draft, setDraft] = useState<RoutineDraftState>(EMPTY_DRAFT)
  const [undoStack, setUndoStack] = useState<UndoFrame[]>([])
  const [extractOpen, setExtractOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractTarget, setExtractTarget] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string }>>([])
  // 助手栏收起态（user 2026-11-09「要有向右收缩和展开能力」）：纯布局状态，
  // 跨步、跨 kind 共用一份（两种 kind 是同一栏），不落盘——重启回展开。
  const [assistCollapsed, setAssistCollapsed] = useState(false)

  // 两栏宽度可拖（user 2026-11-09「对话区和配置区的宽度可以由用户拖动改变」）：
  // 宽度归助手栏、配置栏吃剩余（与折叠态同一立场：纯布局状态、不落盘）。
  const [assistWidth, setAssistWidth] = useState(WIZARD_ASSIST_DEFAULT_WIDTH)
  // 主体行的实测宽度：分隔条上限的尺子（未测量时 0 → clamp 只落 floor）。
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState(0)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setRowWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 拖动与渲染共用同一把尺（可用宽度 = 行内容宽 − 两栏 gap；分隔条是绝对定位
  // 浮层，不占布局宽度）。拖动时读实时 rect，免得首帧测量与拖动起点差一截。
  const clampAssistWidth = useCallback(
    (desired: number): number => clampWizardAssistWidth(desired, (rowRef.current?.getBoundingClientRect().width ?? rowWidth) - WIZARD_ROW_GAP),
    [rowWidth],
  )
  const assistDrag = useColumnDrag({
    getStartWidth: () => assistWidth,
    direction: -1,
    clamp: clampAssistWidth,
    apply: setAssistWidth,
  })
  const effAssistWidth = clampWizardAssistWidth(assistWidth, rowWidth - WIZARD_ROW_GAP)

  // ── workflow 分支（自 WorkflowCanvasPage 迁入） ──
  const [def, setDef] = useState<WorkflowDefinition>(() =>
    autoWorkflowLayout(normalizeSimpleWorkflow(kindProp === 'workflow' ? blankWorkflow((k) => t(k)) : blankWorkflow((k) => t(k)))),
  )
  const [wfUpdateId, setWfUpdateId] = useState<string | null>(kindProp === 'workflow' ? (workflowId ?? null) : null)
  const [wfErrors, setWfErrors] = useState<string[]>([])
  const [wfWarnings, setWfWarnings] = useState<string[]>([])
  // workflow 助手会话槽（routine 的 boundId/sessionReset 同款）：首次保存前是
  // 草稿桶，保存时升格到 workflow 自己的槽位。
  const [wfBoundId, setWfBoundId] = useState<string | null>(kindProp === 'workflow' ? (workflowId ?? null) : null)
  const [wfSessionReset, setWfSessionReset] = useState(0)

  // workflow 预填（编辑既有）
  useEffect(() => {
    if (kind !== 'workflow' || !workflowId) return
    let alive = true
    void (async () => {
      try {
        const loaded = (await window.electronAPI.pipelineWorkflows('get', workflowId)) as WorkflowDefinition | null
        if (!alive) return
        if (!loaded) {
          notify.warning('该工作流已不存在，已切换到新建')
          setWfUpdateId(null)
          setWfBoundId(null)
          return
        }
        setDef(autoWorkflowLayout(normalizeSimpleWorkflow(loaded)))
        setDirty(false)
        setWfUpdateId(loaded.id)
        setWfBoundId(loaded.id)
      } catch (err) {
        console.warn('[TaskWizard] workflow prefill failed:', err)
      }
    })()
    return () => {
      alive = false
    }
  }, [kind, workflowId])

  // routine 预填（编辑既有）
  useEffect(() => {
    if (kind !== 'routine' || !routineId) return
    let alive = true
    void (async () => {
      try {
        const routine = await window.electronAPI.routineGet(routineId)
        if (!alive) return
        if (!routine) {
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
        console.warn('[TaskWizard] prefill failed:', err)
      }
    })()
    return () => {
      alive = false
    }
  }, [kind, routineId])

  // 模板预填（routine 新建）
  const templateAppliedRef = useRef(false)
  useEffect(() => {
    if (kind !== 'routine' || routineId || templateAppliedRef.current || settingsLoading) return
    const template = routineTemplateById(templateId)
    templateAppliedRef.current = true
    if (!template) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming a one-shot navigation param
    setDraft(draftFromTemplate(template, settings.locale === 'en' ? 'en' : 'zh'))
    setDirty(false)
    setBoundId(null)
    setUpdateId(null)
  }, [templateId, kind, routineId, settingsLoading, settings.locale])

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

  // 对话草稿交接（存为日常任务）
  const chatDraftAppliedRef = useRef(false)
  useEffect(() => {
    if (kind !== 'routine' || routineId || chatDraftAppliedRef.current) return
    if (!routineDraft) return
    chatDraftAppliedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming a one-shot navigation param
    applyExtractedDraft(routineDraft)
  }, [routineDraft, kind, routineId, applyExtractedDraft])

  // ── 两个助手会话（routine 自 RoutineEditorPage 迁入，原样；workflow 同构） ──
  // 两条都常驻挂载，非当前 kind 的那条 convId=null → 休眠（useFormAssistSession
  // 的休眠契约），同一时刻只有一条活会话；切换 kind 不丢各自的线程。
  const assistConvId = formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, boundId)
  const wfAssistConvId = formAssistConversationId(WORKFLOW_ASSIST_SPEC.conversationPrefix, wfBoundId)
  const discardBoundSession = useCallback((): void => {
    setUndoStack([])
    void discardAssistConversation(assistConvId).then(() => setSessionReset((n) => n + 1))
  }, [assistConvId])
  const discardWorkflowSession = useCallback((): void => {
    setUndoStack([])
    void discardAssistConversation(wfAssistConvId).then(() => setWfSessionReset((n) => n + 1))
  }, [wfAssistConvId])

  const routineAssist = useFormAssistSession({
    convId: kind === 'routine' ? assistConvId : null,
    title: `[日常助手] ${draft.name.trim() || '新建任务'}`,
    spec: ROUTINE_ASSIST_SPEC,
    systemPrompt: buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC, settings.locale === 'en' ? 'en' : 'zh'),
    allowedTools: ROUTINE_ASSIST_ALLOWED_TOOLS,
    expertProfile: ROUTINE_ASSISTANT_PROFILE,
    resetKey: sessionReset,
    onPatch: (patch) => {
      setUndoStack((stack) => [...stack, { kind: 'routine', draft, dirty }])
      setDraft(applyAssistantPatch(patch, draft))
      setDirty(true)
    },
  })

  // workflow 的补丁落地前先过保存同一道门：画布是硬门，不合法的链一律不写
  // （助手不是用户，没有「先存个坏的再改」这回事）。不合法时不推 undo 帧——
  // 撤销条按帧数门控，不会假装有东西可撤。
  const workflowAssist = useFormAssistSession({
    convId: kind === 'workflow' ? wfAssistConvId : null,
    title: `[任务助手] ${def.name.trim() || '新建工作流'}`,
    spec: WORKFLOW_ASSIST_SPEC,
    systemPrompt: buildFormAssistSystemPrompt(WORKFLOW_ASSIST_SPEC, settings.locale === 'en' ? 'en' : 'zh'),
    allowedTools: WORKFLOW_ASSIST_ALLOWED_TOOLS,
    expertProfile: WORKFLOW_ASSISTANT_PROFILE,
    resetKey: wfSessionReset,
    onPatch: (patch) => {
      const normalized = normalizeSimpleWorkflow(applyWorkflowAssistantPatch(patch, def))
      const v = validateWorkflow(normalized)
      if (!v.ok) {
        setWfErrors(v.errors)
        setStep('content')
        notify.error(t('workflow.assistRejected'))
        return
      }
      setUndoStack((stack) => [...stack, { kind: 'workflow', def, dirty }])
      setDef(autoWorkflowLayout(normalized))
      // 图已经落画布，但保存门还多一条「每个状态必填定义」——这里顺手跑一次
      // 把它立刻回显，用户当场就看到哪几个状态没写定义，不必等到保存才被拦。
      // **只报不拒**：草稿语义不变，硬门仍只在 saveWorkflow 那一处。
      setWfErrors(validateWorkflow(normalized, { requireVerdictDefs: true }).errors)
      setWfWarnings(v.warnings)
      setDirty(true)
    },
  })

  const assist = kind === 'routine' ? routineAssist : workflowAssist

  useEffect(() => {
    if (kind !== 'routine' || boundId !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reset empties the undo stack as part of one user-visible discard
    discardBoundSession()
  }, [kind, boundId, discardBoundSession])
  // workflow 新建态同款：进来先把草稿桶丢掉，保证每次新建都从干净线程开始。
  useEffect(() => {
    if (kind !== 'workflow' || wfBoundId !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same one-shot discard as the routine arm
    discardWorkflowSession()
  }, [kind, wfBoundId, discardWorkflowSession])

  const editDraft = (next: RoutineDraftState): void => {
    setDraft(next)
    setDirty(true)
  }
  const mutateWf = useCallback((fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    setDef((d) => fn(d))
    setDirty(true)
  }, [])

  const goBack = (): void => {
    const action = () => navigate({ kind: 'routines' })
    if (!dirty) {
      action()
      return
    }
    modal.confirm({
      title: '当前修改尚未保存',
      content: '离开将丢失未保存的修改。',
      okText: '丢弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: action,
    })
  }

  // ── routine 保存（原样迁入） ──
  const saveRoutine = async (): Promise<void> => {
    const error = validateDraft(draft)
    if (error) {
      notify.error(error)
      return
    }
    setSaving(true)
    try {
      const input = draftToRoutineInput(draft)
      const updated = updateId ? await window.electronAPI.routineUpdate(updateId, input) : null
      if (updateId && updated) {
        notify.success('已保存')
      } else {
        const created = await window.electronAPI.routineCreate(input)
        setUpdateId(created.id)
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
    } catch (err) {
      console.warn('[TaskWizard] routine save failed:', err)
      notify.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  // ── workflow 保存（自 WorkflowCanvasPage 迁入） ──
  const saveWorkflow = async (): Promise<void> => {
    const normalized = normalizeSimpleWorkflow(def)
    // 用户落盘这一道门比读取/启动严：每个结果状态都必须写一句定义（user
    // 2026-11-09「状态定义是必填的」）。助手提案（上面的 onPatch）只把这条
    // 当作提示回显（图照常落画布），真正的必填由用户保存时兑现，报错逐条点名
    // 节点与状态。
    const v = validateWorkflow(normalized, { requireVerdictDefs: true })
    setWfWarnings(v.warnings)
    if (!v.ok) {
      setWfErrors(v.errors)
      setStep('content')
      return
    }
    setWfErrors([])
    try {
      await window.electronAPI.pipelineWorkflows('save', normalized)
      setDef(normalized)
      setWfUpdateId(normalized.id)
      // 首次保存：草稿桶里的助手线程升格到工作流自己的槽位（routine 同款；
      // 空线程只丢弃不升格）。不升格的话线程永远停在 draft 槽，下一个新建
      // 任务会把别人的对话接过来。
      if (wfBoundId === null) {
        await promoteAssistDraftToEntity(
          workflowAssist.messages,
          WORKFLOW_ASSIST_SPEC.conversationPrefix,
          wfAssistConvId,
          normalized.id,
          `[任务助手] ${normalized.name.trim() || '新建工作流'}`,
        )
        setWfBoundId(normalized.id)
      }
      setDirty(false)
      message.success(t('workflow.canvasSaved'))
    } catch (err) {
      setWfErrors([err instanceof Error ? err.message : String(err)])
    }
  }

  const save = (): void => {
    void (kind === 'routine' ? saveRoutine() : saveWorkflow())
  }

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
  const askAssistant = (text: string): void => {
    assist.send(text, kind === 'routine' ? formSnapshot() : workflowFormSnapshot(def))
  }

  const undoAssistantPatch = (): void => {
    const frame = undoStack[undoStack.length - 1]
    if (!frame) return
    setUndoStack((stack) => stack.slice(0, -1))
    // 帧自带 kind（切换类型会清栈，所以顶帧恒属当前 kind；按帧还原只是
    // 把不变量写死，不靠调用顺序）。
    if (frame.kind === 'routine') setDraft(frame.draft)
    else setDef(frame.def)
    setDirty(frame.dirty)
    assist.clearAppliedPatch()
    notify.success(t('formAssist.undone'))
  }

  const openExtract = (): void => {
    setExtractTarget(null)
    setExtractOpen(true)
    void window.electronAPI
      .listConversations()
      .then((list) => {
        setConversations(list.map((c) => ({ id: c.id, title: c.title })))
      })
      .catch(() => {})
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
          modelMaxTokens: profile.maxTokens,
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
      console.error('[TaskWizard] extract failed:', err)
      notify.error('提取失败')
    } finally {
      setExtracting(false)
    }
  }

  // ── kind 切换（仅新建态）──
  // 换 kind = 换一份空白表单 + 清撤销栈（帧带 kind，跨 kind 的栈没有任何
  // 可还原的对象）+ 把助手会话槽退回草稿桶（下一条线程从干净状态起）。
  const resetForKind = (next: TaskKind): void => {
    setDirty(false)
    setUndoStack([])
    if (next === 'workflow') {
      setDef(autoWorkflowLayout(normalizeSimpleWorkflow(blankWorkflow((k) => t(k)))))
      setWfUpdateId(null)
      setWfBoundId(null)
      setWfErrors([])
      setWfWarnings([])
    } else {
      setDraft({ ...EMPTY_DRAFT })
      setUpdateId(null)
      setBoundId(null)
    }
  }
  const switchKind = (next: TaskKind): void => {
    if (next === kind) return
    if (dirty) {
      modal.confirm({
        title: '当前修改尚未保存',
        content: '切换类型将丢失未保存的修改。',
        okText: '切换',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: () => {
          setKind(next)
          resetForKind(next)
        },
      })
      return
    }
    setKind(next)
    resetForKind(next)
  }

  // ── workflow 的调度 shim：friendly 调度器（ScheduleSection）写回 def.schedule ──
  const wfScheduleDraft: RoutineDraftState = {
    ...EMPTY_DRAFT,
    ...draftScheduleFromCron(def.schedule?.cron ?? ''),
    catchUp: def.schedule?.catchUp ?? 'skip',
  }
  const wfScheduleChange = (next: RoutineDraftState): void => {
    const cron = next.scheduleEnabled ? configToCron(next.sched) : ''
    mutateWf((d) => ({ ...d, schedule: cron ? { cron, catchUp: next.catchUp } : undefined }))
  }

  // ── workflow 的「触发与批量」shim（2026-11-08 两模式能力对齐，以对话式任务为准）：
  //    与 routine 渲染同一对 Section 组件，draft 壳只为复用绑定 ——
  //    params ↔ def.inputs（表头自动识别要落到变量声明上）、batch/triggers 直通。
  //    并发行照常渲染但锁定：工作流的实例是串行 FIFO（每个阶段都 commit 工作区，
  //    多实例并发会撞仓），退场会让这个事实不可见（同「显示但禁用」的既有裁定）。
  const wfTriggerDraft: RoutineDraftState = {
    ...EMPTY_DRAFT,
    id: def.id,
    name: def.name,
    params: (def.inputs ?? []).map((inp) => ({ key: inp.key, label: inp.label, required: inp.required, default: inp.default })),
    batch: def.batch,
    triggers: def.triggers,
  }
  const wfTriggerChange = (next: RoutineDraftState): void => {
    mutateWf((d) => ({
      ...d,
      batch: next.batch,
      triggers: next.triggers,
      // 变量行与 def.inputs 一一对应：按 key 找回旧声明，multiline 等字段不被这次
      // 写回洗掉；表头自动识别新增的列在这里长成新变量。
      inputs: next.params.map((p) => {
        const prev = (d.inputs ?? []).find((i) => i.key === p.key)
        return { ...prev, key: p.key, label: p.label, required: p.required, default: p.default }
      }),
    }))
  }

  // ── workflow 变量声明（P3 向导里属「基本信息」步：变量是任务声明）──
  //    user 2026-11-08：与对话式任务**同一个编辑器**（VariableSection）——
  //    两种模式一套行布局与文案，workflow 只是多一个「多行」开关（它的
  //    WorkflowInputDef 真有这一维，启动表单会渲染成文本域）。
  //    key 收紧到 \w：占位符是 {{key}}，键里有空格/标点会让替换歧义。
  const wfInputsChange = (rows: VariableRow[]): void => {
    mutateWf((d) => ({ ...d, inputs: rows.map((r) => ({ ...r, key: r.key.replace(/[^\w]/g, '') })) }))
  }

  const canSave = kind === 'routine' ? draft.name.trim() !== '' && draft.prompt.trim() !== '' : def.name.trim() !== ''
  /** Editing an existing task (either wing). Pins are already fixed by then:
   *  routines and workflows are two different runners/stores, so the kind is a
   *  fact about the row, not a field of the form. */
  const editingTask = !!(updateId || wfUpdateId)
  const stepLabels: Record<WizardStep, string> = {
    basics: t('task.wizardBasics'),
    content: t('task.wizardContent'),
    runctx: t('task.wizardRunCtx'),
    trigger: t('task.wizardTrigger'),
  }

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '0 24px 24px',
        boxSizing: 'border-box',
        background: 'var(--pm-bg)',
      }}
    >
      {/* ── 顶栏：返回 / 标题 / 保存 ── */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0 8px' }}>
        <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={goBack} style={{ marginLeft: -4 }}>
          返回
        </Button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FormOutlined />
          <span>{editingTask ? t('task.wizardEdit') : t('task.wizardCreate')}</span>
          {dirty && <span style={{ color: '#faad14', fontWeight: 400 }}>· 未保存</span>}
        </span>
        {kind === 'routine' && !updateId && (
          <Tooltip title="从对话提取任务">
            <Button size="small" type="text" icon={<ImportOutlined />} onClick={openExtract} />
          </Tooltip>
        )}
        <span style={{ flex: 1 }} />
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canSave} onClick={save}>
          {t('common.save')}
        </Button>
      </div>

      {/* ── 步骤条（自由跳转） ── */}
      <div style={{ flexShrink: 0, padding: '0 0 12px' }}>
        <Segmented value={step} onChange={(v) => setStep(v as WizardStep)} options={STEP_ORDER.map((s) => ({ value: s, label: stepLabels[s] }))} />
      </div>

      {/* ── 主体：步骤卡 + 助手卡（页面级并列——助手不属于编辑面板，
          它贯穿全部四步，所以和步骤卡平级）。两栏都是沉浸配方的无底色卡，
          中间那条缝里骑着一根可拖动的分隔条（两条宽度由这一页的几何决定，
          所以 ref/拖拽也是这一页的事）。 ── */}
      <div ref={rowRef} style={{ flex: 1, minHeight: 0, display: 'flex', gap: WIZARD_ROW_GAP, position: 'relative' }}>
        {/* data-pm-wizard-editor: 步骤卡（探针据此断言助手卡不是它的后代）。 */}
        <div style={{ ...EDITOR_CARD_SURFACE, flexDirection: 'column', gap: 10 }} data-pm-wizard-editor>
          {/* 撤销条贯穿四步：助手改的字段可能落在任何一步，不该只在内容步出现。
              门还要求栈里有帧——主人拒绝的补丁不会推帧，不能假装有东西可撤。 */}
          {assist.appliedPatch && undoStack.length > 0 && <UndoBar onUndo={undoAssistantPatch} />}
          <div className="auto-hide-scroll" style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 8 }}>
            {step === 'basics' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* 顺序（user 2026-11-08）：任务名称 → 描述 → 任务类型——先给
                  任务起名，类型放最后（编辑态类型已定：只读展示，不可切）。 */}
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>任务名称</div>
                  <Input
                    value={kind === 'routine' ? draft.name : def.name}
                    onChange={(e) => {
                      const name = e.target.value
                      if (kind === 'routine') editDraft({ ...draft, name })
                      else mutateWf((d) => ({ ...d, name }))
                    }}
                    placeholder={kind === 'routine' ? '例如：每日依赖巡检' : t('workflow.canvasNamePlaceholder')}
                    autoFocus
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>描述</div>
                  <Input
                    value={kind === 'routine' ? draft.description : (def.description ?? '')}
                    onChange={(e) => {
                      const description = e.target.value
                      if (kind === 'routine') editDraft({ ...draft, description })
                      else mutateWf((d) => ({ ...d, description }))
                    }}
                    placeholder="可选，一句话说明这个任务做什么"
                  />
                </div>
                {/* 变量声明从「任务内容」步迁入（user 2026-11-08）——变量属于
                  任务声明而非内容文本。两种 kind 共用同一个编辑器
                  （VariableSection，行布局与文案以对话式任务为准）；workflow
                  多一个「多行」开关，因为它的变量声明真有这一维。 */}
                {kind === 'routine' ? (
                  <ParamsSection draft={draft} onChange={editDraft} />
                ) : (
                  <VariableSection rows={def.inputs ?? []} onChange={wfInputsChange} showMultiline />
                )}
                {/* 任务类型（user 2026-11-09 两条裁定：「编辑存量任务时也要看得到
                  类型」+「期望就是用单选框」）——标签恒渲染，控件始终是同一个单选组：
                  新建态可选，编辑态 disabled（看得到、点不动）。类型决定跑的是哪个
                  运行器、落到哪个 store，改它等于换一个任务，所以编辑态不给改。
                  别改成 Segmented（user 2026-11-08：类型是选择项不是导航面），也别
                  退回「编辑态画只读文本/chip」——用户要的就是单选框。
                  WORKFLOW_TASKS_UI=false（0.5.1 隐藏工作流）时：新建任务只剩
                  对话式任务这一个选项，工作流选项只在「正在编辑一条工作流」时
                  保留——编辑态必须如实显示类型（用户 2026-11-09 裁定），而创建
                  分支不该成为隐藏功能的入口。 */}
                <div data-pm-task-kind>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>任务类型</div>
                  <Radio.Group
                    value={kind}
                    disabled={editingTask}
                    onChange={(e) => switchKind(e.target.value as TaskKind)}
                    options={[
                      { value: 'routine', label: t('task.kindRoutine') },
                      ...(WORKFLOW_TASKS_UI || kind === 'workflow'
                        ? [{ value: 'workflow', label: t('task.kindWorkflow') }]
                        : []),
                    ]}
                  />
                </div>
              </div>
            )}

            {step === 'content' && kind === 'routine' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <PromptContentSection draft={draft} onChange={editDraft} />
              </div>
            )}

            {step === 'content' && kind === 'workflow' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
                {(wfErrors.length > 0 || wfWarnings.length > 0) && (
                  <div role="alert" style={wfErrors.length > 0 ? ALERT_ERROR : ALERT_WARN}>
                    {wfErrors.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600 }}>{t('workflow.canvasErrors')}</div>
                        {wfErrors.map((e, i) => (
                          <div key={i}>{e}</div>
                        ))}
                      </>
                    )}
                    {wfWarnings.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600 }}>{t('workflow.canvasWarnings')}</div>
                        {wfWarnings.map((w, i) => (
                          <div key={i}>{w}</div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <div style={{ flex: 1, minHeight: 480 }}>
                  <WorkflowCanvas def={def} mutate={mutateWf} />
                </div>
              </div>
            )}

            {step === 'runctx' && (
              <TaskRunContextFields
                value={kind === 'routine' ? draft : { workspaceDir: def.workspaceDir, approvalMode: def.approvalMode, profileId: def.profileId }}
                onChange={(patch) => {
                  if (kind === 'routine') editDraft({ ...draft, ...patch })
                  else mutateWf((d) => ({ ...d, ...patch }))
                }}
                models={models}
                activeModelId={activeModelId}
              />
            )}

            {step === 'trigger' && kind === 'routine' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <ScheduleSection draft={draft} onChange={editDraft} />
                <BatchSection draft={draft} onChange={editDraft} />
                <TriggersSection draft={draft} onChange={editDraft} />
              </div>
            )}

            {step === 'trigger' && kind === 'workflow' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <ScheduleSection draft={wfScheduleDraft} onChange={wfScheduleChange} />
                <BatchSection
                  draft={wfTriggerDraft}
                  onChange={wfTriggerChange}
                  concurrency={{
                    locked: true,
                    reason: '工作流一次只跑一行：每个阶段都会提交工作区，多实例并发会撞在一起。',
                  }}
                />
                <TriggersSection draft={wfTriggerDraft} onChange={wfTriggerChange} webhook={{ kind: 'workflow', id: def.id }} />
              </div>
            )}
          </div>
        </div>

        {/* ── 助手卡（两种 kind 同一栏，只有 spec/会话槽分叉） ──
            无底色卡片壳 + 向右收起（user 2026-11-09）；折叠与宽度都归这一页
            ——两栏宽度是这一行的几何，不是助手组件自己的私事。 */}
        <FormAssistColumn
          session={assist}
          collapsed={assistCollapsed}
          onToggleCollapsed={() => setAssistCollapsed((v) => !v)}
          width={effAssistWidth}
          resizing={assistDrag.dragging}
          title={kind === 'routine' ? t('formAssist.routineColumnTitle') : t('formAssist.workflowColumnTitle')}
          placeholder={kind === 'routine' ? t('formAssist.routinePlaceholder') : t('formAssist.workflowPlaceholder')}
          emptyIntro={kind === 'routine' ? t('formAssist.routineIntro') : t('formAssist.workflowIntro')}
          emptyExamples={
            kind === 'routine'
              ? [t('formAssist.routineExample1'), t('formAssist.routineExample2')]
              : [t('formAssist.workflowExample1'), t('formAssist.workflowExample2')]
          }
          profiles={settings.profiles}
          activeProfileId={settings.activeProfileId}
          onSelectProfile={(profileId) => void switchProfile(profileId)}
          onSendMessage={askAssistant}
          onNewSession={kind === 'routine' ? discardBoundSession : discardWorkflowSession}
        />

        {/* 分隔条（user 2026-11-09「对话区和配置区的宽度可以由用户拖动改变」）。
            它是两栏的**兄弟**而不是挂在卡里的装饰：两张卡都是 overflow:hidden，
            挂在卡内的手柄会在缝隙里被裁掉。助手栏贴右，所以手柄骑在它左缘、
            向左拖变宽（direction -1）。收起态没有可拖的东西，整根退场。 */}
        {!assistCollapsed && (
          <div
            data-pm-wizard-drag-handle
            role="separator"
            aria-orientation="vertical"
            onPointerDown={assistDrag.onPointerDown}
            onPointerMove={assistDrag.onPointerMove}
            onPointerUp={assistDrag.onPointerUp}
            onPointerCancel={assistDrag.onPointerUp}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              right: effAssistWidth + WIZARD_ROW_GAP / 2 - COLUMN_DRAG_HANDLE_WIDTH / 2,
              width: COLUMN_DRAG_HANDLE_WIDTH,
              cursor: 'col-resize',
              zIndex: 2,
              background: 'transparent',
            }}
          />
        )}
      </div>

      {/* 从对话提取（routine） */}
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
                padding: '8px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 13,
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

/** 撤销条（步骤卡顶部渲染；等同 RoutineForm 的 AppliedPatchBar 面）。 */
function UndoBar({ onUndo }: { onUndo: () => void }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--pm-fill)',
        fontSize: 12,
        color: 'var(--pm-text-secondary)',
      }}
    >
      <RobotOutlined />
      <span style={{ flex: 1 }}>{t('formAssist.autoFilled')}</span>
      <Button size="small" onClick={onUndo}>
        {t('formAssist.undo')}
      </Button>
    </div>
  )
}

const ALERT_ERROR: React.CSSProperties = {
  flexShrink: 0,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--pm-border)',
  background: 'var(--pm-warn-bg, #fff7e6)',
  color: 'var(--pm-error, #cf1322)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}
const ALERT_WARN: React.CSSProperties = {
  flexShrink: 0,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--pm-border)',
  background: 'var(--pm-fill)',
  color: 'var(--pm-text-muted)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}

export default TaskWizardPage
