// ── Project create modal (PLAN-0.4.0 M3.7, reused by the welcome page's
// project picker; management UI is gone — the welcome flow is the only place
// a project is created, collecting name + workspace, nothing else) ──
// Workspace input is validated twice (2026-09: 手工输入需要校验): the pure
// format check in shared/workspace-path answers on every keystroke, and a
// debounced PROJECT_VALIDATE_DIR probe catches existence/permission problems
// the format cannot see. A blank name is auto-filled from the path's last
// segment so typing (or picking) the workspace first is enough.

import React, { useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Space } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import type { Project, ProjectCreateInput, ProjectUpdateInput } from '../../../../shared/types/project'
import { basenameOfPath, checkWorkspacePathFormat } from '../../../../shared/workspace-path'

/** ms of typing quiet before the workspace path is probed on the main side. */
const DIR_PROBE_DELAY_MS = 500

export function ProjectModal({ open, editing, onClose, onSaved }: {
  open: boolean
  editing: Project | null
  onClose: () => void
  /** Called after a successful save with the created/updated project (create only). */
  onSaved: (project?: Project) => void
}): React.ReactElement {
  const { message } = AntdApp.useApp()
  const [name, setName] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [dirError, setDirError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The probe result of an earlier keystroke must not label a newer input —
  // only the value this ref still points at may write dirError.
  const latestDirRef = useRef('')

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
      setWorkspaceDir(editing?.workspaceDir ?? '')
      setDirError(null)
      latestDirRef.current = editing?.workspaceDir ?? ''
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

  const save = async (): Promise<void> => {
    if (!name.trim() || (!editing && !workspaceDir.trim())) return
    setSaving(true)
    try {
      if (editing) {
        // workspaceDir is fixed at creation — renames only.
        const patch: ProjectUpdateInput = { name }
        await window.electronAPI.projectUpdate(editing.id, patch)
        onSaved()
      } else {
        // 目录即身份 (M8.4): one directory backs at most one project. Creating
        // against an occupied directory would silently fork its conversations,
        // so adopt the existing project instead.
        const projects = await window.electronAPI.projectList()
        const existing = projects.find((p) => p.id !== 'default' && p.workspaceDir === workspaceDir)
        if (existing) {
          message.info(`该目录已被项目「${existing.name}」使用，已为你选中它。`)
          onSaved(existing)
          onClose()
          return
        }
        const input: ProjectCreateInput = { name, workspaceDir }
        const project = await window.electronAPI.projectCreate(input)
        onSaved(project)
      }
      onClose()
    } catch (err) {
      // Duplicate names / unusable workspace dirs surface from the main process.
      message.error(err instanceof Error ? err.message : String(err))
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
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>项目名称</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：my-app" autoFocus />
        </div>
        {editing ? (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>工作区（创建后不可修改）</div>
            <code style={{ fontSize: 12, color: '#666', wordBreak: 'break-all' }}>{editing.workspaceDir}</code>
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>工作区</div>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={workspaceDir}
                onChange={(e) => updateWorkspaceDir(e.target.value)}
                placeholder="/path/to/workspace"
                status={dirError ? 'error' : undefined}
              />
              <Button icon={<FolderOpenOutlined />} onClick={pickDir} />
            </Space.Compact>
            {dirError && <div style={{ marginTop: 6, fontSize: 12, color: '#ff4d4f' }}>{dirError}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}
