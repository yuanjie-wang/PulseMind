// ── Routine center (日常工作) ──
// PLAN-0.4.0 M4.3 / M4.4: list + editor + run history + "extract from
// conversation". Routines are user-triggered / scheduled prompt tasks (D3),
// distinct from skills.

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Drawer, Input, Modal, Select, Space, Switch, Tag, Tooltip } from 'antd'
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, HistoryOutlined, PlusOutlined, ImportOutlined, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { createLlmAdapter } from '../../llm'
import { RoutineExtractionAgent } from '../../agent/one-shot-agent'
import { checkCron, nextRun } from '../../../../shared/schedule/cron'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { Project } from '../../../../shared/types/project'

const CRON_PRESETS = [
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '每周五 18:00', value: '0 18 * * 5' },
  { label: '每月 1 号', value: '0 0 1 * *' },
]

const RUN_STATUS_TAG: Record<RoutineRun['status'], { color?: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  skipped: { text: '已跳过' },
}

interface RoutineDraftState {
  id?: string
  name: string
  description: string
  prompt: string
  cron: string
  catchUp: 'once' | 'skip'
  enabled: boolean
  projectId?: string
  params: Array<{ key: string; label: string; required?: boolean; default?: string }>
}

const EMPTY_DRAFT: RoutineDraftState = {
  name: '', description: '', prompt: '', cron: '', catchUp: 'once', enabled: true, params: [],
}

function describeCron(cron: string): string | null {
  if (!cron) return null
  const check = checkCron(cron)
  if (!check.valid) return `无效表达式：${cron}`
  const next = nextRun(cron)
  return next ? new Date(next).toLocaleString() : cron
}

function RoutineCenter(): React.ReactElement {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const { settings } = useSettings()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [draft, setDraft] = useState<RoutineDraftState | null>(null)
  const [runsFor, setRunsFor] = useState<Routine | null>(null)
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [extracting, setExtracting] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractTarget, setExtractTarget] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string }>>([])

  const reload = useCallback(async () => {
    try {
      setRoutines(await window.electronAPI.routineList())
      setProjects(await window.electronAPI.projectList())
    } catch (err) {
      console.warn('[RoutineCenter] load failed:', err)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const loadRuns = useCallback(async (routine: Routine) => {
    setRuns(await window.electronAPI.routineRuns(routine.id, 30))
  }, [])

  const cronCheck = draft?.cron ? checkCron(draft.cron) : null

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (draft.cron && !checkCron(draft.cron).valid) {
      message.error('cron 表达式无效')
      return
    }
    const base = {
      name: draft.name.trim() || '未命名任务',
      description: draft.description,
      prompt: draft.prompt,
      enabled: draft.enabled,
      projectId: draft.projectId,
      params: draft.params.filter((p) => p.key.trim()),
      schedule: draft.cron ? { cron: draft.cron, catchUp: draft.catchUp } : undefined,
    }
    if (draft.id) await window.electronAPI.routineUpdate(draft.id, base)
    else await window.electronAPI.routineCreate(base)
    setDraft(null)
    void reload()
  }

  const runNow = async (routine: Routine): Promise<void> => {
    const params: Record<string, string> = {}
    for (const p of routine.params ?? []) params[p.key] = p.default ?? ''
    await window.electronAPI.routineRun(routine.id, params)
    message.success(`已开始执行「${routine.name}」，完成后会通知你`)
    void reload()
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
        void reload()
      },
    })
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
      const apiKey = settings.profiles.find((p) => p.id === settings.activeProfileId)?.apiKey
      if (!apiKey) {
        message.error('请先在设置中配置 API Key')
        return
      }
      const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
      const agent = new RoutineExtractionAgent()
      const draftResult = await agent.execute(
        { conversationText: lines.join('\n\n'), locale: settings.locale === 'en' ? 'en' : 'zh' },
        {
          llmConfig: {
            apiKey,
            baseURL: profile?.baseURL || '',
            model: profile?.model || '',
            adapter: createLlmAdapter(profile?.provider ?? 'anthropic'),
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
        cron: draftResult.cron,
        sourceConversationId: extractTarget,
      } as RoutineDraftState)
    } catch (err) {
      console.error('[RoutineCenter] extract failed:', err)
      message.error('提取失败')
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
      <style>{`
        .routine-row:hover { background: rgba(0,0,0,0.03); }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>{t('viewTitle.routines')}</span>
        <Space>
          <Button icon={<ImportOutlined />} onClick={() => {
            setExtractTarget(null)
            setExtractOpen(true)
            void window.electronAPI.listConversations().then((list) => {
              setConversations(list.map((c) => ({ id: c.id, title: c.title })))
            }).catch(() => {})
          }}>
            从对话提取
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            新建任务
          </Button>
        </Space>
      </div>

      {routines.length === 0 && (
        <div style={{ color: '#999', padding: '32px 0', fontSize: 13 }}>
          还没有日常工作。新建一个提示词任务，或从一段对话中提炼；可以立即执行，也可以绑定 cron 定时跑。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {routines.map((routine) => {
          const nextAt = routine.enabled && routine.schedule ? describeCron(routine.schedule.cron) : null
          return (
            <div
              key={routine.id}
              className="routine-row"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #f0f0f0' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{routine.name}</span>
                  {routine.schedule?.cron && checkCron(routine.schedule.cron).valid && <Tag color="black">定时</Tag>}
                  {routine.projectId && routine.projectId !== 'default' && (
                    <Tag>{projects.find((p) => p.id === routine.projectId)?.name ?? routine.projectId}</Tag>
                  )}
                </div>
                {routine.description && (
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {routine.description}
                  </div>
                )}
                <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                  {routine.enabled && nextAt ? `下次运行：${nextAt}` : routine.enabled ? '手动执行' : '已停用'}
                </div>
              </div>
              <Switch
                size="small"
                checked={routine.enabled}
                onChange={(checked) => void window.electronAPI.routineToggle(routine.id, checked).then(reload)}
              />
              <Tooltip title="立即运行">
                <Button type="text" icon={<PlayCircleOutlined style={{ fontSize: 17 }} />} onClick={() => void runNow(routine)} />
              </Tooltip>
              <Tooltip title="运行历史">
                <Button type="text" icon={<HistoryOutlined style={{ fontSize: 16 }} />} onClick={() => { setRunsFor(routine); void loadRuns(routine) }} />
              </Tooltip>
              <Tooltip title="编辑">
                <Button type="text" icon={<EditOutlined style={{ fontSize: 15 }} />} onClick={() => setDraft({
                  id: routine.id,
                  name: routine.name,
                  description: routine.description,
                  prompt: routine.prompt,
                  cron: routine.schedule?.cron ?? '',
                  catchUp: routine.schedule?.catchUp ?? 'once',
                  enabled: routine.enabled,
                  projectId: routine.projectId,
                  params: routine.params ?? [],
                })} />
              </Tooltip>
              <Tooltip title="删除">
                <Button type="text" danger icon={<DeleteOutlined style={{ fontSize: 15 }} />} onClick={() => removeRoutine(routine)} />
              </Tooltip>
            </div>
          )
        })}
      </div>

      {/* Editor */}
      <Drawer
        title={draft?.id ? '编辑任务' : '新建任务'}
        open={draft != null}
        onClose={() => setDraft(null)}
        width={560}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button onClick={() => setDraft(null)} style={{ marginInlineEnd: 8 }}>取消</Button>
            <Button type="primary" disabled={!draft?.name.trim() || !draft?.prompt.trim()} onClick={() => void saveDraft()}>保存</Button>
          </div>
        }
      >
        {draft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>任务名称</div>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：每日依赖巡检" autoFocus />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>描述（可选）</div>
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>提示词（独立可执行；用 {'{{参数名}}'} 引用参数）</div>
              <Input.TextArea
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                rows={8}
                placeholder="例如：检查 {{repo}} 仓库的依赖是否有已知安全漏洞，输出报告。"
              />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>参数（可选）</div>
              {draft.params.map((p, i) => (
                <Space key={i} style={{ display: 'flex', marginBottom: 6 }}>
                  <Input style={{ width: 110 }} value={p.key} placeholder="参数名" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, key: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Input style={{ width: 120 }} value={p.label} placeholder="显示名" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, label: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Input style={{ width: 140 }} value={p.default} placeholder="默认值" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, default: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setDraft({ ...draft, params: draft.params.filter((_, j) => j !== i) })} />
                </Space>
              ))}
              <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setDraft({ ...draft, params: [...draft.params, { key: '', label: '' }] })}>
                添加参数
              </Button>
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>定时计划（cron，留空 = 仅手动）</div>
              <Space.Compact style={{ width: '100%' }}>
                <Input value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} placeholder="0 9 * * 1-5" />
                <Select
                  style={{ width: 140 }}
                  placeholder="预设"
                  options={CRON_PRESETS}
                  onChange={(v) => setDraft({ ...draft, cron: v })}
                />
              </Space.Compact>
              <div style={{ fontSize: 11, marginTop: 4, color: cronCheck && !cronCheck.valid ? '#cf1322' : '#999' }}>
                {draft.cron
                  ? cronCheck?.valid
                    ? `下次运行：${new Date(nextRun(draft.cron)!).toLocaleString()}`
                    : `表达式无效：${cronCheck?.error}`
                  : '不设置定时，只能手动执行'}
              </div>
            </div>
            {draft.cron && (
              <div>
                <div style={{ marginBottom: 6, fontSize: 13 }}>错过计划时（应用没开着）</div>
                <Select
                  value={draft.catchUp}
                  onChange={(catchUp) => setDraft({ ...draft, catchUp })}
                  options={[
                    { value: 'once', label: '打开应用后补跑一次' },
                    { value: 'skip', label: '跳过，等下一个计划点' },
                  ]}
                  style={{ width: 240 }}
                />
              </div>
            )}
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>执行项目（决定工作区与沙箱）</div>
              <Select
                allowClear
                value={draft.projectId}
                onChange={(projectId) => setDraft({ ...draft, projectId })}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                placeholder="默认项目"
                style={{ width: 280 }}
              />
            </div>
          </div>
        )}
      </Drawer>

      {/* Run history */}
      <Drawer
        title={`运行历史 · ${runsFor?.name ?? ''}`}
        open={runsFor != null}
        onClose={() => setRunsFor(null)}
        width={480}
      >
        {runs.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>还没有运行记录。</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((run) => (
            <div key={run.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag color={RUN_STATUS_TAG[run.status].color}>{RUN_STATUS_TAG[run.status].text}</Tag>
                <span style={{ fontSize: 12, color: '#888' }}>{run.trigger === 'schedule' ? '定时' : '手动'}</span>
                <span style={{ fontSize: 11, color: '#bbb', marginInlineStart: 'auto' }}>{new Date(run.startedAt).toLocaleString()}</span>
              </div>
              {run.error && <div style={{ fontSize: 12, color: '#cf1322', marginTop: 6 }}>{run.error}</div>}
              {run.conversationId && (
                <Button
                  type="link"
                  size="small"
                  style={{ paddingInlineStart: 0 }}
                  onClick={() => setRunsFor(null)}
                >
                  会话 {run.conversationId.slice(0, 18)}…
                </Button>
              )}
            </div>
          ))}
        </div>
      </Drawer>

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

export default RoutineCenter
