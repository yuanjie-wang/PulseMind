// ── General settings section (常规，原「环境设置」) ──
// 设置 → 常规: language, appearance, the launch/data-cleanup preferences
// (moved here out of 数据与运行, 2026-09-21), the agent run limits (loop
// iterations / parallel sub-agents) and the default workspace directory.
// The read-only OS/time/directory rows lived here once and are gone — the
// workspace picker is the only path surface left. Drawer-capable but
// rendered inline in the settings page.
import React, { useState, useEffect } from 'react'
import { Alert, Drawer, Input, InputNumber, Button, Typography, Space, Select, Switch, Modal } from 'antd'
import { SaveOutlined, GlobalOutlined, BgColorsOutlined, ThunderboltOutlined, TeamOutlined, FolderOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { DataPaths } from '../../types/electron'
import type { AppSettings } from '../../types/settings'
import { retentionOptions } from './retention-options'

const { Text } = Typography

interface EnvironmentSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
  /** 数据清理's retention save prunes expired conversations main-side
   *  (SETTINGS_SET awaits cleanupExpiredConversations); the caller refreshes
   *  the conversation list so pruned sessions never linger as clickable
   *  ghosts that a later open resurrects (saveConversation is an UPSERT). */
  onReloadConversations?: () => void
}

function EnvironmentSettings({ open, onClose, inline, onReloadConversations }: EnvironmentSettingsProps): React.ReactElement {
  const { settings, loading, saving, saveSettings } = useSettings()
  const { locale, setLocale, t } = useTranslation()
  const [modal, modalHolder] = Modal.useModal()
  const [dataPaths, setDataPaths] = useState<DataPaths | null>(null)
  const [localWorkspaceDir, setLocalWorkspaceDir] = useState(settings.workspaceDir || '')
  const [localLoopLimit, setLocalLoopLimit] = useState(settings.maxLoopIterations ?? 200)
  const [localParallelLimit, setLocalParallelLimit] = useState(settings.maxParallelSubAgents ?? 5)
  const [busy, setBusy] = useState(false)
  const disabled = loading || saving || busy

  // Sync the draft fields and load the data paths on open
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- modal-open reset: re-seeds the draft fields from props; the async path load follows
      setLocalWorkspaceDir(settings.workspaceDir || '')
      setLocalLoopLimit(settings.maxLoopIterations ?? 200)
      setLocalParallelLimit(settings.maxParallelSubAgents ?? 5)
      window.electronAPI
        .getDataPaths()
        .then(setDataPaths)
        .catch(() => {
          setDataPaths(null)
        })
    }
  }, [open, settings.workspaceDir])

  // The launch/cleanup toggles are LIVE settings — each writes exactly its own
  // field over the current object (the contract 数据与运行's group had before
  // moving here), while the workspace dir and the run limits stay behind the
  // 保存 button at the bottom.
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

  const handleSave = async () => {
    try {
      await saveSettings({
        ...settings,
        workspaceDir: localWorkspaceDir,
        maxLoopIterations: localLoopLimit,
        maxParallelSubAgents: localParallelLimit,
      })
      notify.success(t('environmentDrawer.saved'))
    } catch {
      notify.error(t('environmentDrawer.saveFailed'))
    }
  }

  const handleLocaleChange = (newLocale: 'zh' | 'en') => {
    setLocale(newLocale)
    saveSettings({ ...settings, locale: newLocale })
  }

  // PLAN-dark-mode M1: the theme preference saves immediately, like the
  // language above. App.tsx resolves 'system' against prefers-color-scheme and
  // flips html[data-theme]; main re-resolves it for the title-bar overlay on
  // the SETTINGS_SET this triggers.
  const handleThemeChange = (next: 'light' | 'dark' | 'system') => {
    void saveSettings({ ...settings, theme: next })
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
        {t('environmentDrawer.title')}
      </Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {/* Language Selector — top */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <GlobalOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.language')}
          </Text>
          <Select
            value={locale}
            onChange={handleLocaleChange}
            style={{ width: '100%' }}
            options={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>

        {/* Appearance (PLAN-dark-mode M1) — three-way, saved immediately. */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <BgColorsOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.appearance')}
          </Text>
          <Select
            value={settings.theme ?? 'light'}
            onChange={handleThemeChange}
            style={{ width: '100%' }}
            options={[
              { value: 'light', label: t('environmentDrawer.appearanceLight') },
              { value: 'dark', label: t('environmentDrawer.appearanceDark') },
              { value: 'system', label: t('environmentDrawer.appearanceSystem') },
            ]}
          />
        </div>

        {/* 启动 / 数据清理 — moved here out of 数据与运行 (2026-09-21).
            Live writes through save() above; the retention confirm lives
            there too, because the main-side handler awaits the prune. */}
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

        {/* Agent run limits — editable like the fields above. */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            <ThunderboltOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.maxLoopIterations')}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('environmentDrawer.maxLoopIterationsHelp')}
          </Text>
          <InputNumber
            min={1}
            max={500}
            step={10}
            value={localLoopLimit}
            onChange={(val) => setLocalLoopLimit(val ?? 200)}
            style={{ width: '100%' }}
          />
        </div>

        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            <TeamOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.maxParallelSubAgents')}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('environmentDrawer.maxParallelSubAgentsHelp')}
          </Text>
          <InputNumber
            min={1}
            max={10}
            value={localParallelLimit}
            onChange={(val) => setLocalParallelLimit(val ?? 5)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Default workspace — the one path surface left on this pane. */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <FolderOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.workspace')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder={dataPaths?.workspaceDir || t('environmentDrawer.workspacePlaceholder')}
              value={localWorkspaceDir}
              onChange={(e) => setLocalWorkspaceDir(e.target.value)}
            />
            <Button
              type="text"
              size="small"
              icon={<FolderOpenOutlined />}
              style={{ marginLeft: 8, marginTop: 4 }}
              onClick={() => {
                const dir = localWorkspaceDir || dataPaths?.workspaceDir
                if (dir) {
                  window.electronAPI.openFolder(dir).catch((err: unknown) => {
                    notify.error(err instanceof Error ? err.message : String(err))
                  })
                }
              }}
            />
          </Space.Compact>
        </div>

        {/* Save Button */}
        <Button type="primary" block icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          {t('environmentDrawer.save')}
        </Button>
      </Space>
      {modalHolder}
    </>
  )

  if (inline) {
    return (
      <div style={{ height: '100%', overflow: 'auto' }}>
        {body}
      </div>
    )
  }

  return (
    <>
      <Drawer title={t('environmentDrawer.title')} open={open} onClose={onClose} size={400}>
        {body}
      </Drawer>
    </>
  )
}

export default EnvironmentSettings
