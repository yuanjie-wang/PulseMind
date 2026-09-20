import React, { useEffect, useState } from 'react'
import {Alert, Button, Drawer, Modal, Select, Space, Switch, Typography } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { DataPaths } from '../../types/electron'
import type { AppSettings } from '../../types/settings'
import { retentionOptions } from './retention-options'

const { Text } = Typography

interface DataRuntimeSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
  /** M4 (review 2026-09-18): SETTINGS_SET awaits cleanupExpiredConversations,
   *  so a tightened retention window deletes rows main-side while this tab is
   *  the only visible surface — the caller reloads the conversation list
   *  here, or pruned sessions linger as clickable ghosts that a later open
   *  resurrects (saveConversation is an UPSERT). */
  onReloadConversations?: () => void
}

/** These are live settings, not a form draft: the other retention surfaces share them. */
function DataRuntimeSettings({ open, onClose, inline, onReloadConversations }: DataRuntimeSettingsProps): React.ReactElement {
  const { settings, loading, saving, saveSettings } = useSettings()
  const { t } = useTranslation()
  const [modal, modalHolder] = Modal.useModal()
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
  }, [open, settings.workspaceDir])

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    if (disabled) return
    setBusy(true)
    try {
      const days = patch.conversationRetentionDays
      if (days !== undefined && days > 0) {
        const confirmed = await modal.confirm({
          title: t('dataRuntime.retentionConfirmTitle'),
          content: t('dataRuntime.retentionConfirmContent', { n: days }),
          okText: t('common.confirm'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
        })
        if (!confirmed) return
      }
      await saveSettings({ ...settings, ...patch })
      // The main-side handler already awaited the prune — refresh now, in the
      // success branch only (a failed save deleted nothing).
      onReloadConversations?.()
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

  const heading = (key: string) => (
    <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 12 }}>{t(`dataRuntime.${key}`)}</Text>
  )
  const toggle = (key: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
      <div>
        <Text strong style={{ display: 'block', fontSize: 13 }}>{t(`dataRuntime.${key}`)}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t(`dataRuntime.${key}Help`)}</Text>
      </div>
      <Switch aria-label={t(`dataRuntime.${key}`)} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
  const options = retentionOptions(t).map(({ days, label }) => ({ value: days, label }))

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>
        {t('dataRuntime.title')}
      </Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <section>
          {heading('launch')}
          {toggle('launchAtLogin', settings.launchAtLogin ?? false, (value) => { void save({ launchAtLogin: value }) })}
        </section>
        <section>
          {heading('cleanup')}
          {toggle('autoCleanup', settings.autoCleanup ?? false, (value) => { void save({ autoCleanup: value }) })}
          <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>{t('dataRuntime.conversationRetention')}</Text>
          <Select aria-label={t('dataRuntime.conversationRetention')} style={{ width: '100%' }} disabled={disabled}
            value={settings.conversationRetentionDays ?? 0} options={options}
            onChange={(days: number) => { void save({ conversationRetentionDays: days }) }} />
          <Alert type="warning" showIcon style={{ marginTop: 8, marginBottom: 16 }} title={t('dataRuntime.conversationRetentionHelp')} />
          <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>{t('dataRuntime.runRetention')}</Text>
          <Select aria-label={t('dataRuntime.runRetention')} style={{ width: '100%' }} disabled={disabled}
            value={settings.routineRunRetentionDays ?? 0} options={options}
            onChange={(days: number) => { void save({ routineRunRetentionDays: days }) }} />
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>{t('dataRuntime.runRetentionHelp')}</Text>
        </section>
        {/* 高级 — the power-user toggles that used to be scattered across
            「知识库」and「调试」groups; the directory rows moved to 环境设置,
            which is the single directory surface now. */}
        <section>
          {heading('advanced')}
          {toggle('debugLlmRequests', settings.debugLlmRequests ?? false, (value) => { void save({ debugLlmRequests: value }) })}
          <Button icon={<FolderOpenOutlined />} disabled={!paths?.dataDir} style={{ marginBottom: 16 }}
            onClick={() => { if (paths) void openFolder(`${paths.dataDir}/logs/llm-requests`) }}>
            {t('dataRuntime.openLogDir')}
          </Button>
          {toggle('gitContextInjection', settings.git?.contextInjection ?? true, (value) => {
            void save({ git: { ...settings.git, contextInjection: value } })
          })}
          {toggle('autoCompile', settings.knowledge?.autoCompile ?? false, (value) => {
            void save({ knowledge: { ...settings.knowledge, autoCompile: value } })
          })}
        </section>
      </Space>
    </>
  )
  return (
    <>
      {modalHolder}
      {inline ? body : <Drawer title={t('dataRuntime.title')} open={open} onClose={onClose} size={440}>{body}</Drawer>}
    </>
  )
}

export default DataRuntimeSettings
