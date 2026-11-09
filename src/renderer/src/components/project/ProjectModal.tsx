// ── Project create/edit modal (PLAN-0.4.0 M3.7; 编辑模式 2026-09-18) ──
// One modal, two modes: create (name + workspace) and edit (name + overview,
// workspace shown read-only — it is fixed at creation). The welcome page's
// project picker created the create flow; the sidebar/welcome edit entries
// drive the edit one.
// Workspace input is validated twice (2026-09: 手工输入需要校验): the pure
// format check in shared/workspace-path answers on every keystroke, and a
// debounced PROJECT_VALIDATE_DIR probe catches existence/permission problems
// the format cannot see. A blank name is auto-filled from the path's last
// segment so typing (or picking) the workspace first is enough.
// 项目概述 (≤50 字, optional): manual input in both modes; edit mode adds
// 自动总结, a one-shot LLM rewrite of the field — it fills the box, never
// saves by itself, and read-only context (conversation titles + last messages
// + workspace top-level names) is gathered fresh per click.

import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Space } from 'antd'
import { notify } from '../../utils/notify'
import { FolderOpenOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { Project, ProjectCreateInput, ProjectUpdateInput } from '../../../../shared/types/project'
import { PROJECT_OVERVIEW_MAX_LENGTH } from '../../../../shared/types/project'
import { basenameOfPath, checkWorkspacePathFormat } from '../../../../shared/workspace-path'
import { useSettings } from '../../hooks/SettingsContext'
import { createLlmAdapter } from '../../llm'
import { ProjectOverviewAgent } from '../../agent/one-shot-agent'

/** ms of typing quiet before the workspace path is probed on the main side. */
const DIR_PROBE_DELAY_MS = 500

/** Context caps for 自动总结 — briefs per conversation, workspace entries,
 *  and the visible tail of a last message. All read-only, all local. */
const SUMMARIZE_CONVERSATIONS = 8
const SUMMARIZE_WORKSPACE_ENTRIES = 30
const SUMMARIZE_MESSAGE_TAIL = 80

/** antd Form 的必填星号，手写版——本弹窗的标签是普通 div，不走 Form.Item。 */
const REQUIRED_MARK = <span style={{ color: 'var(--pm-error-status)', marginRight: 4 }}>*</span>

export function ProjectModal({ open, editing, onClose, onSaved }: {
  open: boolean
  editing: Project | null
  onClose: () => void
  /** Called after a successful save with the created/updated project (create only). */
  onSaved: (project?: Project) => void
}): React.ReactElement {
  
  const { settings, activeProfile } = useSettings()
  const [name, setName] = useState('')
  const [overview, setOverview] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [dirError, setDirError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The probe result of an earlier keystroke must not label a newer input —
  // only the value this ref still points at may write dirError.
  const latestDirRef = useRef('')
  // 自动总结 resolves after awaits; a close/reopen of the modal must not let a
  // stale result overwrite the freshly-repopulated field — each open mints a
  // token and only the still-current one may write state.
  const summarizeTokenRef = useRef(0)
  const overviewAgentRef = useRef(new ProjectOverviewAgent())

  const clearProbe = (): void => {
    if (probeTimer.current) {
      clearTimeout(probeTimer.current)
      probeTimer.current = null
    }
  }
  useEffect(() => clearProbe, [])

  // Form fields repopulate from `editing` when the modal finishes opening —
  // an event callback rather than a state-resetting effect.
  const afterOpenChange = (open: boolean): void => {
    if (open) {
      setName(editing?.name ?? '')
      setOverview(editing?.overview ?? '')
      setWorkspaceDir(editing?.workspaceDir ?? '')
      setDirError(null)
      latestDirRef.current = editing?.workspaceDir ?? ''
      summarizeTokenRef.current++ // a summarize left in flight by the last open is now stale
      setSummarizing(false)
      clearProbe()
    }
  }

  /** One entry point for every workspace write (typed or dialog-picked):
   *  format verdict immediately, main-side probe once typing goes quiet. */
  const updateWorkspaceDir = (next: string): void => {
    setWorkspaceDir(next)
    const trimmed = next.trim()
    latestDirRef.current = trimmed
    const formatError = trimmed ? checkWorkspacePathFormat(trimmed) : null
    setDirError(formatError)
    // 先填工作区时，路径最后一段就是现成的项目名 — only into a blank name,
    // never over something the user already typed.
    const derived = basenameOfPath(trimmed)
    if (trimmed && derived && !name.trim()) setName(derived)
    clearProbe()
    if (!trimmed || formatError) return
    probeTimer.current = setTimeout(async () => {
      const res = await window.electronAPI.projectValidateDir(trimmed)
      if (latestDirRef.current === trimmed) setDirError(res.ok ? null : res.error ?? '该目录不可用作工作区')
    }, DIR_PROBE_DELAY_MS)
  }

  const pickDir = async (): Promise<void> => {
    const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    if (!res.canceled && res.filePaths[0]) updateWorkspaceDir(res.filePaths[0])
  }

  /** 自动总结 (edit mode only, per the feature's ruling): gather the project's
   *  conversations + workspace listing, ask the one-shot agent, fill the box.
   *  Fills — never saves; the user still owns the text. */
  const summarize = async (): Promise<void> => {
    if (!editing || summarizing) return
    if (!activeProfile?.baseURL || !activeProfile.model) {
      notify.warning('请先在 设置 → 模型设置 中配置模型')
      return
    }
    setSummarizing(true)
    const token = ++summarizeTokenRef.current
    try {
      const convs = await window.electronAPI.listConversations()
      const briefs = convs
        .filter((c) => c.projectId === editing.id)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, SUMMARIZE_CONVERSATIONS)
        .map((c) => {
          const tail = (c.lastMessage ?? '').trim().slice(0, SUMMARIZE_MESSAGE_TAIL)
          return tail ? `「${c.title}」最近提到：${tail}` : `「${c.title}」`
        })
      const dir = await window.electronAPI.listDir(editing.workspaceDir).catch(() => null)
      const entries = (dir?.entries ?? [])
        .slice(0, SUMMARIZE_WORKSPACE_ENTRIES)
        .map((e) => e.name)
      const text = await overviewAgentRef.current.execute(
        {
          name: name.trim() || editing.name,
          conversationBriefs: briefs,
          workspaceEntries: entries,
          locale: settings.locale === 'en' ? 'en' : 'zh',
        },
        {
          llmConfig: {
            adapter: createLlmAdapter(activeProfile.provider ?? 'anthropic'),
            apiKey: activeProfile.apiKey ?? '',
            baseURL: activeProfile.baseURL,
            model: activeProfile.model,
            modelMaxTokens: activeProfile.maxTokens,
          },
          maxOutputTokens: 2048,
        },
      )
      if (token !== summarizeTokenRef.current) return // modal closed/reopened mid-flight
      if (text) setOverview(text)
      else notify.warning('自动总结没有生成结果，请手动填写')
    } catch (err) {
      if (token === summarizeTokenRef.current) {
        notify.warning(`自动总结失败：${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      if (token === summarizeTokenRef.current) setSummarizing(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || (!editing && !workspaceDir.trim())) return
    setSaving(true)
    try {
      if (editing) {
        // workspaceDir is fixed at creation — name/overview only. The overview
        // always rides the patch so clearing it (empty string) clears the
        // stored value instead of being read as "not in this patch".
        const patch: ProjectUpdateInput = { name, overview: overview.trim() }
        await window.electronAPI.projectUpdate(editing.id, patch)
        onSaved()
      } else {
        // 目录即身份 (M8.4): one directory backs at most one project. Creating
        // against an occupied directory would silently fork its conversations,
        // so adopt the existing project instead.
        const projects = await window.electronAPI.projectList()
        const existing = projects.find((p) => p.id !== 'default' && p.workspaceDir === workspaceDir)
        if (existing) {
          notify.info(`该目录已被项目「${existing.name}」使用，已为你选中它。`)
          onSaved(existing)
          onClose()
          return
        }
        const input: ProjectCreateInput = { name, workspaceDir, overview: overview.trim() || undefined }
        const project = await window.electronAPI.projectCreate(input)
        onSaved(project)
      }
      onClose()
    } catch (err) {
      // Duplicate names / unusable workspace dirs surface from the main process.
      notify.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = Boolean(name.trim() && (editing || (workspaceDir.trim() && !dirError)))

  return (
    <Modal
      title={editing ? '项目设置' : '新建项目'}
      open={open}
      onCancel={onClose}
      onOk={save}
      afterOpenChange={afterOpenChange}
      width={480}
      cancelText="取消"
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ loading: saving, disabled: !canSubmit }}
      // Both create paths land in the new-task state and hand focus to the
      // welcome composer; antd's default would yank it back to the trigger
      // after the close animation.
      focusable={{ focusTriggerAfterClose: false }}
    >
      {/* 创建时工作区排最前：填目录即可从路径尾段自动带出项目名，流程从这里开始。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
        {!editing && (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>{REQUIRED_MARK}工作区</div>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={workspaceDir}
                onChange={(e) => updateWorkspaceDir(e.target.value)}
                placeholder="/path/to/workspace"
                status={dirError ? 'error' : undefined}
                autoFocus
              />
              <Button icon={<FolderOpenOutlined />} onClick={pickDir} />
            </Space.Compact>
            {dirError && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--pm-error-status)' }}>{dirError}</div>}
          </div>
        )}
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>{REQUIRED_MARK}项目名称</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：my-app" />
        </div>
        {/* antd 的 showCount 计数是 position:absolute、bottom:-22px，悬在输入框
            下缘之外而容器不为它留位——右对齐的计数会压到下方右对齐的按钮上
            （创建/保存），这里在字段内预留它的整行高度。 */}
        <div style={{ paddingBottom: 22 }}>
          <div style={{ marginBottom: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              项目概述
              <span style={{ color: 'var(--pm-text-muted)', marginLeft: 4 }}>（选填，{PROJECT_OVERVIEW_MAX_LENGTH} 字以内）</span>
            </span>
            {editing && (
              <Button
                type="link"
                size="small"
                icon={<ThunderboltOutlined />}
                loading={summarizing}
                onClick={() => { void summarize() }}
                style={{ padding: 0, height: 22 }}
              >
                自动总结
              </Button>
            )}
          </div>
          <Input.TextArea
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            maxLength={PROJECT_OVERVIEW_MAX_LENGTH}
            showCount
            autoSize={{ minRows: 2, maxRows: 3 }}
            placeholder="一句话说明这个项目是做什么的，会随对话告知 AI"
          />
        </div>
        {editing && (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>工作区（创建后不可修改）</div>
            <code style={{ fontSize: 12, color: 'var(--pm-text-secondary)', wordBreak: 'break-all' }}>{editing.workspaceDir}</code>
          </div>
        )}
      </div>
    </Modal>
  )
}
