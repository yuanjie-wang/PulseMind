// ── Advanced settings section (高级，原「数据与运行」) ──
// The power-user toggles: run-time keep-awake, LLM request dumping (+ its log
// directory), Git status injection and knowledge auto-compile. 启动/数据清理
// moved to 常规 (2026-09-21); the read-only directory rows are gone entirely —
// the workspace picker on 常规 is the one path surface left.
import React, { useEffect, useState } from 'react'
import {Button, Drawer, Space, Switch, Typography } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { DataPaths } from '../../types/electron'
import type { AppSettings } from '../../types/settings'

const { Text } = Typography

interface DataRuntimeSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

/** These are live settings, not a form draft: every toggle writes its own
 *  field over the current object the moment it flips. */
function DataRuntimeSettings({ open, onClose, inline }: DataRuntimeSettingsProps): React.ReactElement {
  const { settings, loading, saving, saveSettings } = useSettings()
  const { t } = useTranslation()
  const [paths, setPaths] = useState<DataPaths | null>(null)
  const [busy, setBusy] = useState(false)
  const disabled = loading || saving || busy

  useEffect(() => {
    if (!open) return
    let disposed = false
    void window.electronAPI.getDataPaths().then((value) => {
      if (!disposed) setPaths(value)
    }).catch((err: unknown) => {
      if (!disposed) notify.error(err instanceof Error ? err.message : String(err))
    })
    return () => { disposed = true }
  }, [open])

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    if (disabled) return
    setBusy(true)
    try {
      await saveSettings({ ...settings, ...patch })
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (path: string): Promise<void> => {
    try {
      await window.electronAPI.openFolder(path)
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    }
  }

  const toggle = (key: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
      <div>
        <Text strong style={{ display: 'block', fontSize: 13 }}>{t(`dataRuntime.${key}`)}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t(`dataRuntime.${key}Help`)}</Text>
      </div>
      <Switch aria-label={t(`dataRuntime.${key}`)} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>
        {t('dataRuntime.title')}
      </Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {toggle('keepAwake', settings.keepAwakeEnabled ?? false, (value) => {
          void save({ keepAwakeEnabled: value })
        })}
        {toggle('debugLlmRequests', settings.debugLlmRequests ?? false, (value) => { void save({ debugLlmRequests: value }) })}
        <Button icon={<FolderOpenOutlined />} disabled={!paths?.dataDir} style={{ marginBottom: 16 }}
          onClick={() => { if (paths) void openFolder(`${paths.dataDir}/logs/llm-requests`) }}>
          {t('dataRuntime.openLogDir')}
        </Button>
        {toggle('gitContextInjection', settings.git?.contextInjection ?? false, (value) => {
          void save({ git: { ...settings.git, contextInjection: value } })
        })}
        {toggle('projectCommandsInjection', settings.commands?.projectInjection ?? false, (value) => {
          void save({ commands: { ...settings.commands, projectInjection: value } })
        })}
        {toggle('autoCompile', settings.knowledge?.autoCompile ?? false, (value) => {
          void save({ knowledge: { ...settings.knowledge, autoCompile: value } })
        })}
      </Space>
    </>
  )
  return (
    <>
      {inline ? body : <Drawer title={t('dataRuntime.title')} open={open} onClose={onClose} size={440}>{body}</Drawer>}
    </>
  )
}

export default DataRuntimeSettings
