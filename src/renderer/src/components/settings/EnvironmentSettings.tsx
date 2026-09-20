// ── Environment settings section ──
// 设置 → 环境: language, appearance, OS info and the runtime data
// directories. The local-agent-service / browser-extension / browser-kernel
// blocks used to live here; the extension panel owns the service toggle now
// and the browser kernel runs on its stored defaults. Drawer-capable but
// rendered inline in the settings page.
import React, { useState, useEffect } from 'react'
import {Drawer, Input, Button, Typography, Space, Select } from 'antd'
import { SaveOutlined, DesktopOutlined, ClockCircleOutlined, FolderOutlined, FolderOpenOutlined, GlobalOutlined, BgColorsOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { PlatformInfo, DataPaths } from '../../types/electron'

const { Text } = Typography

function formatCurrentTime(): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

interface EnvironmentSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

function EnvironmentSettings({ open, onClose, inline }: EnvironmentSettingsProps): React.ReactElement {
  const { settings, saving, saveSettings } = useSettings()
  const { locale, setLocale, t } = useTranslation()
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [dataPaths, setDataPaths] = useState<DataPaths | null>(null)
  const [localWorkspaceDir, setLocalWorkspaceDir] = useState(settings.workspaceDir || '')
  const [currentTime, setCurrentTime] = useState(formatCurrentTime())

  // Load platform info and data paths on open
  useEffect(() => {
    if (open) {
      setLocalWorkspaceDir(settings.workspaceDir || '')
      setCurrentTime(formatCurrentTime())
      window.electronAPI
        .getPlatformInfo()
        .then(setPlatformInfo)
        .catch(() => {
          setPlatformInfo({ platform: 'Unknown', platformName: '', release: '', arch: '', ripgrepPath: null })
        })
      window.electronAPI
        .getDataPaths()
        .then(setDataPaths)
        .catch(() => {
          setDataPaths(null)
        })
    }
  }, [open, settings.workspaceDir])

  // Update clock every second while drawer is open
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setCurrentTime(formatCurrentTime()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const handleSave = async () => {
    try {
      await saveSettings({ ...settings, workspaceDir: localWorkspaceDir })
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

  const platformLabel = platformInfo ? `${platformInfo.platformName} ${platformInfo.release} (${platformInfo.arch})` : t('environmentDrawer.loading')

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

        {/* OS Info */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <DesktopOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.operatingSystem')}
          </Text>
          <Input value={platformLabel} readOnly variant="filled" />
        </div>

        {/* Current Time */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <ClockCircleOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.currentTime')}
          </Text>
          <Input value={currentTime} readOnly variant="filled" />
        </div>

        {/* Config Directory */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <FolderOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.configDirectory')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={dataPaths?.dataDir || (platformInfo?.platform === 'win32' ? '%USERPROFILE%\\.pulsemind' : '~/.pulsemind')}
              readOnly
              variant="filled"
            />
            <Button
              type="text"
              size="small"
              icon={<FolderOpenOutlined />}
              style={{ marginLeft: 8, marginTop: 4 }}
              onClick={() => dataPaths?.dataDir && window.electronAPI.openFolder(dataPaths.dataDir)}
            />
          </Space.Compact>
        </div>

        {/* Skills Directory */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <FolderOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.skillsDirectory')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={dataPaths?.skillsDir || (platformInfo?.platform === 'win32' ? '%USERPROFILE%\\.pulsemind\\skills' : '~/.pulsemind/skills')}
              readOnly
              variant="filled"
            />
            <Button
              type="text"
              size="small"
              icon={<FolderOpenOutlined />}
              style={{ marginLeft: 8, marginTop: 4 }}
              onClick={() => dataPaths?.skillsDir && window.electronAPI.openFolder(dataPaths.skillsDir)}
            />
          </Space.Compact>
        </div>

        {/* Knowledge Directory — consolidated here from 数据与运行 (the one
            directory surface; DataRuntimeSettings no longer repeats it) */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <FolderOutlined style={{ marginRight: 6 }} />
            {t('environmentDrawer.knowledgeDirectory')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={dataPaths?.knowledgeDir || (platformInfo?.platform === 'win32' ? '%USERPROFILE%\\.pulsemind\\knowledge' : '~/.pulsemind/knowledge')}
              readOnly
              variant="filled"
            />
            <Button
              type="text"
              size="small"
              icon={<FolderOpenOutlined />}
              style={{ marginLeft: 8, marginTop: 4 }}
              onClick={() => dataPaths?.knowledgeDir && window.electronAPI.openFolder(dataPaths.knowledgeDir)}
            />
          </Space.Compact>
        </div>

        {/* Workspace Directory */}
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
                if (dir) window.electronAPI.openFolder(dir)
              }}
            />
          </Space.Compact>
        </div>

        {/* Save Button */}
        <Button type="primary" block icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          {t('environmentDrawer.save')}
        </Button>
      </Space>
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
