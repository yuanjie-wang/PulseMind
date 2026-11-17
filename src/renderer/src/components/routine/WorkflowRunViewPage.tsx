// ── 工作流运行视图·整页（user 2026-11-16「模态框区域太小，改成页面」 +
// 2026-11-17「左 DAG + 右节点详情，点谁看谁」）──
// 近期运行里 workflow 行点击直达这里（kind:'routines' +
// workflowRunViewId 经 ViewHost 路由）：左侧流程图（同一张正交路由画布切到
// 运行查看态），右侧是**选中节点**的处理详情——点画布上的节点看它的落库
// 转写（多次执行时面板顶部给执行次数选择条），点开始芯片看任务初始要求，
// 点结束芯片看最终结果。进入页面默认选中最后一个有执行记录的节点。
//
// 数据自取：pipelineRuns(runId) 一次带回 run + stage 行；3s 轮询（对齐近期
// 运行的节奏），页面卸载/文档隐藏即停。定义加载按 workflowId 去重——轮询的
// 新 run 对象不得把画布卸载重挂（视口复位教训，PLAN-workflow-run-view）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { RUN_STATUS_TAG } from './RoutineWorkspace'
import { WorkflowCanvas } from './WorkflowCanvas'
import { TranscriptView } from '../chat/TranscriptView'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { storedMessagesToAgentMessages } from '../../utils/message-utils'
import { COLUMN_DRAG_HANDLE_WIDTH, IMMERSIVE_CARD_RADIUS } from '../../../../shared/ui/layout-widths'
import type { AgentMessage } from '../../types/agent'
import type { PipelineRun, PipelineStageRun, WorkflowDefinition } from '../../../../shared/workflow/types'
import { verdictKindOf } from '../../../../shared/workflow/run-view'
import { normalizeSimpleWorkflow } from '../../../../shared/workflow/simplify'
import { autoWorkflowLayout } from '../../../../shared/workflow/layout'

const POLL_MS = 3_000
// 只读转写的必填 handler 契约（TranscriptView 是活会话的形状）：viewOnly 面
// 永远不会触发它们，给 no-op——与 SubAgentSessionView 的子会话预览同一份。
const noop = (): void => {}
/** 双栏间距与面板宽度（user 2026-11-16「间距只留5px，允许调整宽度」；
 *  2026-11-17「默认左4右6，左边最小宽度200」）：默认宽 = 行宽的 60%，拖拽
 *  夹紧 = [280, 行宽 − 200]（右栏的上限由左栏的最小宽度决定）。 */
const RUN_VIEW_GAP = 5
const PANEL_MIN_WIDTH = 280
const LEFT_MIN_WIDTH = 200
/** 首帧（行宽还没量到）的占位宽——挂载后立即被 60% 实测值覆盖。 */
const PANEL_PLACEHOLDER_WIDTH = 400

/** 右栏的选中目标：画布节点（按 nodeId，多次执行时再选第几次）/
 *  开始芯片（任务初始要求）/ 结束芯片（最终结果）。 */
type PanelSelection = { kind: 'node'; nodeId: string } | { kind: 'start' } | { kind: 'done' }

/** 节点的只读转写：hydrateConversation 把落库的 pipe_ 会话带回来（含
 *  tool_result 的落库内容），TranscriptView 以 viewOnly 渲染——不看、也不建
 *  活动会话（运行结束的 stage 不该被继续追问）。
 *
 *  必须过 `storedMessagesToAgentMessages`：tool_use.status 是运行时字段、不
 *  落库，直接拿原始行渲染会让每个工具块都停在 status undefined → 全屏
 *  「执行状态未知」（2026-11-17 用户实报）。该转换按 tool_result 配对回填
 *  completed——与子代理预览/历史会话同一份（这里曾是全仓唯一漏网的加载路径）。
 *
 *  换节点/换执行要落到会话尾部（user 2026-11-17「点击节点后，定位到会话的
 *  尾部」）：滚动容器就是下面这层 div（TranscriptView 的根节点在块流里高度
 *  自适应，从不自己滚——tail-follow 在这条宿主上是空转），而换内容时 React
 *  复用的是同一个 DOM 节点，浏览器会保留「期望滚动偏移」。最新一条输出才是
 *  要看的落点，所以内容落地后把 scrollTop 钉到 scrollHeight。 */
function StageTranscript({ convId }: { convId: string }): React.ReactElement {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<AgentMessage[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 把落点钉到会话尾部。内容落地后连钉两帧：首帧是「空壳 → 有内容」的布局，
   *  第二帧吃掉 markdown/代码块/图片的二次布局；之后不再追高——用户一动手
   *  滚动就不该被拽回底部。 */
  const landAtTail = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    let alive = true
    setMessages(null)
    void window.electronAPI
      .hydrateConversation(convId)
      .then((conv) => {
        if (!alive) return
        setMessages(storedMessagesToAgentMessages(conv?.messages ?? []))
      })
      .catch(() => {
        if (alive) setMessages([])
      })
    return () => {
      alive = false
    }
  }, [convId])

  useEffect(() => {
    if (messages === null) return
    let second = 0
    const first = requestAnimationFrame(() => {
      landAtTail()
      second = requestAnimationFrame(landAtTail)
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [messages])

  return (
    // 面板卡自带圆角描边，转写容器不再叠自己的（user 2026-11-17「不要双层圆角边框」）
    <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <TranscriptView
        messages={messages ?? []}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[]}
        isRequesting={false}
        restoring={messages === null}
        emptyHint={t('workflow.runViewTranscriptEmpty')}
        actions="viewOnly"
        contentInset={0}
        onApproveTool={noop}
        onRejectTool={noop}
        onKillTool={noop}
        onRespondToTool={noop}
        onClearError={noop}
        onRetry={noop}
      />
    </div>
  )
}

export interface WorkflowRunViewPageProps {
  runId: string
}

export function WorkflowRunViewPage({ runId }: WorkflowRunViewPageProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const [run, setRun] = useState<PipelineRun | null>(null)
  const [stages, setStages] = useState<PipelineStageRun[]>([])
  const [missing, setMissing] = useState(false)
  const [def, setDef] = useState<WorkflowDefinition | null>(null)
  /** 右栏选中目标（user 2026-11-17：点谁看谁）。 */
  const [sel, setSel] = useState<PanelSelection | null>(null)
  /** 选中节点的第几次执行（0 起；null = 最近一次）。 */
  const [execPick, setExecPick] = useState<number | null>(null)
  /** 面板宽度（分隔条拖拽，user 2026-11-16「允许调整宽度」）。会话内记忆，
   *  不落盘（与向导助手栏的会话态同一档）。默认 = 行宽 60%（左4右6），
   *  行宽首次量到后覆盖占位值。 */
  const [panelWidth, setPanelWidth] = useState(PANEL_PLACEHOLDER_WIDTH)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const clampPanelWidth = useCallback(
    (desired: number): number => {
      const rowWidth = rowRef.current?.getBoundingClientRect().width ?? PANEL_PLACEHOLDER_WIDTH + PANEL_MIN_WIDTH
      // 右栏上限由「左栏最小 200」决定（user 2026-11-17）
      return Math.max(PANEL_MIN_WIDTH, Math.min(desired, rowWidth - LEFT_MIN_WIDTH))
    },
    [],
  )
  const panelDrag = useColumnDrag({
    getStartWidth: () => panelWidth,
    direction: -1, // 分隔条骑在面板左缘：向左拖 = 面板变宽
    clamp: clampPanelWidth,
    apply: setPanelWidth,
  })

  // 默认比例 左4右6：行宽首次量到（面板分支已挂载）时把占位宽覆盖为实测的
  // 60%——只设一次，之后归分隔条拖拽管。
  const didInitWidth = useRef(false)
  const rowVisible = !missing && run !== null && def !== null
  useEffect(() => {
    if (didInitWidth.current || !rowVisible) return
    const w = rowRef.current?.getBoundingClientRect().width
    if (!w || w <= PANEL_MIN_WIDTH + LEFT_MIN_WIDTH) return
    didInitWidth.current = true
    setPanelWidth(Math.round(w * 0.6))
  }, [rowVisible])

  // 数据自取 + 3s 轮询（运行中推进图与面板；终态后仍轮询但开销是一次 IPC——
  // 与近期运行同一节奏，简单压过省电）。run 不在结果里 = 运行记录被删。
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = (await window.electronAPI.pipelineRuns(runId)) as { run?: PipelineRun; stages?: PipelineStageRun[] }
        if (!alive) return
        if (!res.run) {
          setMissing(true)
          return
        }
        setRun(res.run)
        setStages(res.stages ?? [])
      } catch {
        /* 轮询失败静默，下一拍再来 */
      }
    }
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [runId])

  // 定义按 **workflowId** 加载（轮询的新 run 对象不得触发重载——视口复位教训）。
  const workflowId = run?.workflowId ?? null
  useEffect(() => {
    if (!workflowId) return
    let alive = true
    setDef((prev) => (prev && prev.id === workflowId ? prev : null))
    void (async () => {
      try {
        const loaded = await window.electronAPI.pipelineWorkflows('get', workflowId)
        if (!alive) return
        // 通道是复用 op 的联合（list→数组 / save·toggle→boolean）：'get' 的应答
        // 只认单对象，其余形态按「定义缺席」处理，不给画布喂垃圾。
        //
        // 必须过 `normalizeSimpleWorkflow` + `autoWorkflowLayout`（与
        // TaskWizardPage 的定义落地同一条链）：盘上的定义可能是手写/模板/旧版
        // 产物——节点 `layout` 缺席时 `buildFlowNodes` 把它们全摆在 (0,0)
        // （2026-11-17 实锤 doc-translate-pipeline：三张卡叠成一摞、连线全被
        // 压在卡下面 = 用户报的「连接线又没了」）；`verdicts` 缺席还会让画布
        // 与节点卡的 `.verdicts` 解引用抛错。归一 + 布局都在内存里做，运行视图
        // 的 mutate 是 no-op，绝不回写盘（用户的编辑布局不受影响）。
        if (loaded && !Array.isArray(loaded) && typeof loaded !== 'boolean') {
          setDef(autoWorkflowLayout(normalizeSimpleWorkflow(loaded)))
        }
        // 定义被删：运行记录仍在，画布区如实说明（runViewMissingDef）。
      } catch {
        /* 下一拍轮询不经这里——定义加载失败静默，保持空态 */
      }
    })()
    return () => {
      alive = false
    }
  }, [workflowId])

  // runView 对象 memo 化：status/stages 不变就不给画布新引用（无谓的节点全量
  // 重建会打断拖拽/选中态）。
  const runStatus = run?.status
  const runView = useMemo(
    () => (runStatus ? { status: runStatus, stages } : undefined),
    [runStatus, stages],
  )

  const statusText = run ? (RUN_STATUS_TAG[run.status]?.text ?? run.status) : ''
  // 阶段按开始时间排序 = 执行序。「最终结果」回落链：run 行的一等结论 → 最后
  // 完成阶段的摘要 → 成功但两者皆无（conclusion 字段上线前的历史运行，user
  // 2026-11-17 实锤）⇒ 完成态文案 + 末阶段交付物；失败 ⇒ 引擎错误。
  const orderedStages = useMemo(() => [...stages].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)), [stages])
  const settledStages = orderedStages.filter((s) => s.verdict)
  const finalStage = settledStages[settledStages.length - 1]
  const titleOf = new Map((def?.nodes ?? []).map((n) => [n.id, n.title || n.id]))

  // 默认选中（user 2026-11-17「进入页面后，默认选中最后一个有执行记录的
  // 节点」）：每个 runId 只设一次——运行中不自动跟随（用户点谁看谁）。
  const lastStageKey = orderedStages.length > 0 ? orderedStages[orderedStages.length - 1].id : ''
  const defaultedRef = useRef<string | null>(null)
  useEffect(() => {
    if (defaultedRef.current === runId) return
    if (orderedStages.length === 0) return
    defaultedRef.current = runId
    setSel({ kind: 'node', nodeId: orderedStages[orderedStages.length - 1].nodeId })
    setExecPick(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastStageKey 是 stages 的稳定指纹
  }, [lastStageKey, runId])

  // 画布点击 → 右栏切换（runMode 下 WorkflowCanvas 的 onRunNodeClick 穿透）。
  const onRunNodeClick = useCallback((target: { kind: 'stage'; nodeId: string } | { kind: 'start' } | { kind: 'done' }) => {
    if (target.kind === 'stage') {
      setSel({ kind: 'node', nodeId: target.nodeId })
      setExecPick(null) // 换节点回到最近一次
    } else {
      setSel(target)
    }
  }, [])

  // ── 选中目标的派生数据 ──
  const nodeStages = useMemo(
    () => (sel?.kind === 'node' ? orderedStages.filter((s) => s.nodeId === sel.nodeId) : []),
    [sel, orderedStages],
  )
  const activeStage = nodeStages.length > 0 ? nodeStages[execPick !== null ? Math.min(execPick, nodeStages.length - 1) : nodeStages.length - 1] : undefined

  return (
    // 页面壳对齐任务中心（--pm-bg 全幅 + 分区留白）；双栏 = 两张沉浸配方卡
    // （editor-layout 同一份：--pm-separator-faint 边 + IMMERSIVE_CARD_RADIUS，
    // 与任务向导的步骤卡/助手壳同语言）。
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '16px 24px 24px', background: 'var(--pm-bg)', overflow: 'hidden' }}>
      {/* 头部：返回 + 名称/状态。标题词汇对齐任务中心的区头（14/600/--pm-text-strong）。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px 2px', flexShrink: 0 }}>
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate({ kind: 'routines' })}>
          {t('workflow.runViewBackToTasks')}
        </Button>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{run?.workflowName ?? '…'}</span>
        <span style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}>· {statusText}</span>
      </div>

      {missing ? (
        <div style={{ color: 'var(--pm-text-muted)', fontSize: 12.5, padding: 32, textAlign: 'center' }}>
          {t('workflow.runViewRunMissing')}
        </div>
      ) : !run || !def ? (
        <div style={{ color: 'var(--pm-text-muted)', fontSize: 12.5, padding: 32, textAlign: 'center' }}>…</div>
      ) : (
        <div ref={rowRef} style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', gap: RUN_VIEW_GAP }}>
          <div style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'var(--pm-bg)', border: '1px solid var(--pm-separator-faint)', borderRadius: IMMERSIVE_CARD_RADIUS, overflow: 'hidden' }}>
            <WorkflowCanvas
              def={def}
              // 运行查看态不写定义——mutate 是必填契约，给个 no-op 并永远不会被调
              // （编辑面全体退场，见 WorkflowCanvas 的 runMode 门）。
              mutate={() => undefined}
              runView={runView}
              onRunNodeClick={onRunNodeClick}
            />
          </div>
          {/* 分隔条（骑在面板左缘、向左拖变宽，与任务向导的助手栏分隔条同一
              形态：它是双栏的**兄弟**浮层，不占布局宽度）。 */}
          <div
            data-workflow-run-divider
            role="separator"
            aria-orientation="vertical"
            onPointerDown={panelDrag.onPointerDown}
            onPointerMove={panelDrag.onPointerMove}
            onPointerUp={panelDrag.onPointerUp}
            onPointerCancel={panelDrag.onPointerUp}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              right: panelWidth + RUN_VIEW_GAP / 2 - COLUMN_DRAG_HANDLE_WIDTH / 2,
              width: COLUMN_DRAG_HANDLE_WIDTH,
              cursor: 'col-resize',
              zIndex: 6,
            }}
          />
          {/* 节点详情面板（user 2026-11-17：点谁看谁——不再有阶段总览列表）：
              画布点节点 → 该节点的处理过程（多次执行给选择条）；点开始芯片 →
              任务初始要求；点结束芯片 → 最终结果。 */}
          <div
            data-workflow-run-panel
            style={{
              width: panelWidth, flexShrink: 0, boxSizing: 'border-box', background: 'var(--pm-bg)',
              border: '1px solid var(--pm-separator-faint)', borderRadius: IMMERSIVE_CARD_RADIUS,
              overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
            }}
          >
            {sel === null ? (
              <div style={{ fontSize: 12, color: 'var(--pm-text-quiet)', padding: '8px 2px' }}>
                {t('workflow.runPanelPickHint')}
              </div>
            ) : sel.kind === 'start' ? (
              <>
                {/* 标题栏浅色底（user 2026-11-17），与下方内容卡同一份 --pm-fill 语言 */}
                <div style={{ background: 'var(--pm-fill)', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: 'var(--pm-text-strong)', flexShrink: 0 }}>
                  {t('workflow.runPanelStartTitle')}
                </div>
                <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', flexShrink: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pm-text-muted)', marginBottom: 4 }}>
                    {t('workflow.runViewObjectiveLabel')}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--pm-text-strong)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                    {run.objective?.trim() || t('workflow.runPanelNoObjective')}
                  </div>
                </div>
                {run.inputs && Object.keys(run.inputs).length > 0 && (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', flexShrink: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pm-text-muted)', marginBottom: 4 }}>
                      {t('workflow.runInputsSection')}
                    </div>
                    {Object.entries(run.inputs).map(([k, v]) => (
                      <div key={k} style={{ fontSize: 12, color: 'var(--pm-text-secondary)', lineHeight: 1.6 }}>
                        <span style={{ color: 'var(--pm-text-strong)' }}>{k}</span>：{v}
                      </div>
                    ))}
                  </div>
                )}
                {def.description?.trim() && (
                  <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', lineHeight: 1.5 }}>{def.description}</div>
                )}
              </>
            ) : sel.kind === 'done' ? (
              <>
                <div style={{ background: 'var(--pm-fill)', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: 'var(--pm-text-strong)', flexShrink: 0 }}>
                  {t('workflow.runViewFinalResult')}
                </div>
                {run.conclusion ? (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: 'var(--pm-text-strong)', lineHeight: 1.5, flexShrink: 0 }}>
                    {run.conclusion}
                  </div>
                ) : run.status === 'failed' && run.error ? (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: 'var(--pm-error)', lineHeight: 1.5, flexShrink: 0 }}>
                    {run.error}
                  </div>
                ) : finalStage ? (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', flexShrink: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--pm-text-strong)', lineHeight: 1.5 }}>
                      {t('workflow.runViewCompletedNoSummary')}
                    </div>
                    {finalStage.artifacts && finalStage.artifacts.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', marginTop: 2 }}>
                        {t('workflow.runViewArtifacts')}：{finalStage.artifacts.join('、')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }}>{t('workflow.runViewPendingResult')}</div>
                )}
              </>
            ) : (
              <>
                {/* 节点头：标题 + 该节点最新状态徽标（浅色底标题栏） */}
                <div style={{ background: 'var(--pm-fill)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pm-text-strong)' }}>
                    {titleOf.get(sel.nodeId) ?? sel.nodeId}
                  </span>
                  {activeStage?.verdict && (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        // 颜色跟着状态的语义走（不认词面：成功/失败 也是合法词表）。
                        color:
                          verdictKindOf(def, sel.nodeId, activeStage.verdict) === 'success'
                            ? 'var(--pm-success, #52c41a)'
                            : verdictKindOf(def, sel.nodeId, activeStage.verdict) === 'failure'
                              ? 'var(--pm-error)'
                              : 'var(--pm-text-secondary)',
                      }}
                    >
                      {activeStage.verdict}
                    </span>
                  )}
                  {activeStage && !activeStage.finishedAt && (
                    <span style={{ fontSize: 10.5, color: 'var(--pm-link)' }}>{t('workflow.runBadgeRunning')}</span>
                  )}
                </div>
                {/* 多次执行（RETRY/回边）：面板顶部选择条（user 2026-11-17
                    「浮窗让用户选择」——内嵌选择条比跟随画布坐标的浮窗稳）。 */}
                {nodeStages.length > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--pm-text-muted)' }}>
                      {t('workflow.runPanelExecPick', { count: nodeStages.length })}
                    </span>
                    {nodeStages.map((s, i) => {
                      const active = execPick === null ? i === nodeStages.length - 1 : i === execPick
                      return (
                        <Button
                          key={s.id}
                          size="small"
                          type={active ? 'primary' : 'default'}
                          style={{ padding: '0 8px', height: 22 }}
                          onClick={() => setExecPick(i)}
                        >
                          #{i + 1}
                          {s.verdict ? ` ${s.verdict}` : ''}
                        </Button>
                      )
                    })}
                  </div>
                )}
                {/* 内容：运行中提示 / 落库转写（失败的先亮错误块） */}
                {activeStage && !activeStage.finishedAt ? (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'var(--pm-text-secondary)', lineHeight: 1.5, flexShrink: 0 }}>
                    {t('workflow.runPanelRunningHint')}
                  </div>
                ) : activeStage?.conversationId ? (
                  <>
                    {activeStage.error && (
                      <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'var(--pm-error)', lineHeight: 1.5, flexShrink: 0 }}>
                        {activeStage.error}
                      </div>
                    )}
                    <StageTranscript convId={activeStage.conversationId} />
                  </>
                ) : (
                  <div style={{ background: 'var(--pm-fill)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'var(--pm-text-quiet)', lineHeight: 1.5, flexShrink: 0 }}>
                    {activeStage?.error ?? t('workflow.runPanelNoRecord')}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default WorkflowRunViewPage
