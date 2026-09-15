// ── Environment settings section ──
// 设置 → 环境: workspace directory, data paths, proxy/env vars and other
// runtime environment fields. Drawer-capable but rendered inline in the
// settings page.
import React, { useState, useEffect } from 'react'
import { Drawer, Input, Button, Typography, Space, message, Select, Switch, InputNumber } from 'antd'
import { SaveOutlined, DesktopOutlined, ClockCircleOutlined, FolderOutlined, FolderOpenOutlined, GlobalOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import type { PlatformInfo, DataPaths, ServiceStatus } from '../../types/electron'

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
  const [messageApi, contextHolder] = message.useMessage()
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [serviceBusy, setServiceBusy] = useState(false)
  // Browser runtime (A-M4) — saved immediately on change; synced from settings here.
  const [localBrowserBackend, setLocalBrowserBackend] = useState<'managed' | 'app-view'>(settings.browser?.backend ?? 'app-view')
  const [localBrowserHeadless, setLocalBrowserHeadless] = useState<boolean>(settings.browser?.headless ?? true)
  const [localBrowserTimeoutSec, setLocalBrowserTimeoutSec] = useState<number>(Math.round((settings.browser?.timeoutMs ?? 60_000) / 1000))

  const refreshService = () => {
    window.electronAPI
      .serviceGetStatus()
      .then(setService)
      .catch(() => {})
  }

  // Load platform info and data paths on open
  useEffect(() => {
    if (open) {
      setLocalWorkspaceDir(settings.workspaceDir || '')
      setLocalBrowserBackend(settings.browser?.backend ?? 'app-view')
      setLocalBrowserHeadless(settings.browser?.headless ?? true)
      setLocalBrowserTimeoutSec(Math.round((settings.browser?.timeoutMs ?? 60_000) / 1000))
      setCurrentTime(formatCurrentTime())
      window.electronAPI
        .getPlatformInfo()
        .then(setPlatformInfo)
        .catch(() => {
          setPlatformInfo({ platform: 'Unknown', platformName: '', release: '', arch: '', ripgrepPath: null })
        })
      window.electronAPI
        .serviceGetStatus()
        .then(setService)
        .catch(() => {})
      window.electronAPI
        .getDataPaths()
        .then(setDataPaths)
        .catch(() => {
          setDataPaths(null)
        })
    }
  }, [open, settings.workspaceDir, settings.browser])

  // Update clock every second while drawer is open
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setCurrentTime(formatCurrentTime()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const handleSave = async () => {
    try {
      await saveSettings({ ...settings, workspaceDir: localWorkspaceDir })
      messageApi.success(t('environmentDrawer.saved'))
    } catch {
      messageApi.error(t('environmentDrawer.saveFailed'))
    }
  }

  const handleLocaleChange = (newLocale: 'zh' | 'en') => {
    setLocale(newLocale)
    saveSettings({ ...settings, locale: newLocale })
  }

  const platformLabel = platformInfo ? `${platformInfo.platformName} ${platformInfo.release} (${platformInfo.arch})` : t('environmentDrawer.loading')

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
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

        {/* ── Local agent service (PLAN-0.3.5 M2.4) ── */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
          <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
            本地 Agent 服务
          </Text>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              在本地回环地址开放 Agent 服务,供浏览器扩展等客户端连接。
            </Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text>启用服务</Text>
            <Switch
              checked={service?.enabled ?? false}
              loading={serviceBusy}
              onChange={async (checked) => {
                setServiceBusy(true)
                try {
                  const r = await window.electronAPI.serviceSetEnabled(checked)
                  messageApi.success(checked ? `服务已启动 :${r.port}` : '服务已停止')
                  refreshService()
                } catch {
                  messageApi.error('操作失败')
                } finally {
                  setServiceBusy(false)
                }
              }}
            />
          </div>
          {service?.running && (
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                运行端口
              </Text>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Input value={String(service.port)} readOnly size="small" />
                <Button size="small" onClick={refreshService}>
                  刷新
                </Button>
              </div>
            </div>
          )}
          {service?.enabled && (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                连接 Token(扩展配置用)
              </Text>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Input.Password value={service?.token || ''} readOnly size="small" />
                <Button
                  size="small"
                  onClick={() => {
                    navigator.clipboard?.writeText(service?.token || '')
                    messageApi.success('Token 已复制')
                  }}
                >
                  复制
                </Button>
                <Button
                  size="small"
                  danger
                  loading={serviceBusy}
                  onClick={async () => {
                    setServiceBusy(true)
                    try {
                      const r = await window.electronAPI.serviceResetToken()
                      messageApi.success('Token 已重置,请更新扩展配置')
                      setService((prev) => (prev ? { ...prev, token: r.token } : prev))
                    } catch {
                      messageApi.error('重置失败')
                    } finally {
                      setServiceBusy(false)
                    }
                  }}
                >
                  重置
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ── Browser extension (PLAN-browser-extension M1.5) ── */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
          <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
            浏览器插件
          </Text>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              插件连接本机服务后,可在任意网页右下角唤起面板对话。它的会话不会出现在桌面的会话列表里。
            </Text>
          </div>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              已连接的客户端
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              {service?.clients?.length ? (
                <Text>
                  {service.clients.map((c) => `${c.clientId}${c.sessions > 0 ? `（${c.sessions} 个会话）` : ''}`).join('、')}
                </Text>
              ) : (
                <Text type="secondary">未检测到已连接的插件</Text>
              )}
              <Button size="small" onClick={refreshService}>
                刷新
              </Button>
            </div>
          </div>
          {service?.running && (
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                连接地址(插件设置页可手动填写)
              </Text>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Input value={service.wsUrl} readOnly size="small" />
                <Button
                  size="small"
                  onClick={() => {
                    navigator.clipboard?.writeText(service.wsUrl)
                    messageApi.success('连接地址已复制')
                  }}
                >
                  复制
                </Button>
              </div>
            </div>
          )}
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              加载方式
            </Text>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                先执行 <Text code>npm run build:extension</Text>,再到 <Text code>chrome://extensions</Text> 开启开发者模式,
                选择「加载已解压的扩展程序」。
              </Text>
              {service?.extensionDir ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <Input value={service.extensionDir} readOnly size="small" />
                  <Button size="small" onClick={() => window.electronAPI.openFolder(service.extensionDir!)}>
                    打开目录
                  </Button>
                </div>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    还没有构建产物(out/extension 不存在)。
                  </Text>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Browser runtime (A-M4) ── */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
          <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
            浏览器内核
          </Text>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              浏览器工具使用的内核与启动方式。默认应用内嵌窗格（页面停靠在主窗口右侧，操作全程可见）；托管内核为无头 Chromium，在后台执行。
            </Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text>默认后端</Text>
            <Select
              size="small"
              style={{ minWidth: 150 }}
              value={localBrowserBackend}
              onChange={(v) => {
                setLocalBrowserBackend(v)
                void saveSettings({ ...settings, browser: { ...settings.browser, backend: v } })
              }}
              options={[
                { value: 'app-view', label: '应用内嵌窗格（推荐）' },
                { value: 'managed', label: '托管内核（无头）' },
              ]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text>无头模式（不显示窗口）</Text>
            <Switch
              checked={localBrowserHeadless}
              onChange={(checked) => {
                setLocalBrowserHeadless(checked)
                void saveSettings({ ...settings, browser: { ...settings.browser, headless: checked } })
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text>单次调用上限（秒）</Text>
            <InputNumber
              size="small"
              min={10}
              max={300}
              value={localBrowserTimeoutSec}
              onChange={(v) => {
                const sec = typeof v === 'number' ? v : 60
                setLocalBrowserTimeoutSec(sec)
                void saveSettings({ ...settings, browser: { ...settings.browser, timeoutMs: Math.round(sec * 1000) } })
              }}
              style={{ width: 90 }}
            />
          </div>
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
        {contextHolder}
        {body}
      </div>
    )
  }

  return (
    <>
      {contextHolder}
      <Drawer title={t('environmentDrawer.title')} open={open} onClose={onClose} size={400}>
        {body}
      </Drawer>
    </>
  )
}

export default EnvironmentSettings
