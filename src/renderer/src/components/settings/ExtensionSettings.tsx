// ── Browser extension settings section ──
// 设置 → 浏览器插件: the service toggle the extension connects through, the
// connection facts a client needs, the downloadable extension zip, and the
// load-unpacked guide. Promoted from its environment-settings card
// (PLAN-browser-extension M1.5) into its own panel; every string rides i18n
// where the old card hardcoded Chinese.
import React, { useState, useEffect, useCallback } from 'react'
import { Drawer, Input, Button, Typography, Space, Switch } from 'antd'
import { ApiOutlined, DownloadOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { ServiceStatus } from '../../types/electron'

const { Text } = Typography

/** The extensions page named in guide step g2, rendered as a link that hands
 *  the URL to the OS (the user's browser owns the chrome:// scheme — the
 *  desktop app has no origin of its own to open it in). */
const EXTENSIONS_PAGE = 'chrome://extensions'

const withExtensionsLink = (text: string, onOpen: () => void): React.ReactNode => {
  const parts = text.split(EXTENSIONS_PAGE)
  if (parts.length === 1) return text
  return parts.map((part, i) => (
    <React.Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <a onClick={(e) => { e.preventDefault(); onOpen() }}>{EXTENSIONS_PAGE}</a>
      )}
    </React.Fragment>
  ))
}

interface ExtensionSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

function ExtensionSettings({ open, onClose, inline }: ExtensionSettingsProps): React.ReactElement {
  const { t } = useTranslation()
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [serviceBusy, setServiceBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)

  const refreshService = useCallback(() => {
    window.electronAPI
      .serviceGetStatus()
      .then(setService)
      // Not silent on purpose: a failing status fetch is exactly what makes
      // the toggle "not change" (state stays stale), so leave a trace.
      .catch((err) => console.warn('[ExtensionSettings] service status refresh failed:', err))
  }, [])

  useEffect(() => {
    if (open) refreshService()
  }, [open, refreshService])

  const handleToggle = async (checked: boolean): Promise<void> => {
    setServiceBusy(true)
    try {
      const r = await window.electronAPI.serviceSetEnabled(checked)
      notify.success(checked ? t('extensionSettings.serviceStarted', { port: String(r.port ?? '') }) : t('extensionSettings.serviceStopped'))
      refreshService()
    } catch {
      notify.error(t('extensionSettings.serviceToggleFailed'))
    } finally {
      setServiceBusy(false)
    }
  }

  const openExtensionsPage = (): void => {
    // macOS/Windows hand chrome:// to Chrome when it is installed; a machine
    // where no browser registered the scheme rejects — tell the user instead
    // of failing silently.
    window.electronAPI.openExternal(EXTENSIONS_PAGE).catch(() => {
      notify.error(t('extensionSettings.guideOpenFailed'))
    })
  }

  const copy = (text: string, messageKey: string): void => {
    navigator.clipboard?.writeText(text)
    notify.success(t(messageKey))
  }

  const handleResetToken = async (): Promise<void> => {
    setServiceBusy(true)
    try {
      const r = await window.electronAPI.serviceResetToken()
      notify.success(t('extensionSettings.tokenReset'))
      setService((prev) => (prev ? { ...prev, token: r.token } : prev))
    } catch {
      notify.error(t('extensionSettings.tokenResetFailed'))
    } finally {
      setServiceBusy(false)
    }
  }

  // The main side zips the built extension and asks where to save it; a dev
  // checkout without a build triggers the build first over there.
  const handleExport = async (): Promise<void> => {
    setExportBusy(true)
    try {
      const r = await window.electronAPI.extensionExportZip()
      if (r.ok && r.path) notify.success(t('extensionSettings.exportSaved', { path: r.path }))
      else if (r.canceled) notify.info(t('extensionSettings.exportCanceled'))
      else notify.error(r.message || t('extensionSettings.exportFailed'))
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExportBusy(false)
    }
  }

  const connectionRow = (label: string, value: string, copyKey?: string): React.ReactElement => (
    <div style={{ marginBottom: 12 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
        <Input value={value} readOnly size="small" />
        {copyKey && (
          <Button size="small" onClick={() => copy(value, copyKey)}>
            {t('extensionSettings.copy')}
          </Button>
        )}
      </div>
    </div>
  )

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>
        {t('extensionSettings.title')}
      </Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('extensionSettings.intro')}
          </Text>
        </div>

        {/* Service toggle — the ws server the extension pairs with (was the
            环境「本地 Agent 服务」card). */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong style={{ display: 'block', fontSize: 13 }}>
              {t('extensionSettings.serviceToggle')}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('extensionSettings.serviceToggleHelp')}
            </Text>
          </div>
          <Switch
            data-extension-toggle=""
            aria-label={t('extensionSettings.serviceToggle')}
            checked={service?.enabled ?? false}
            loading={serviceBusy}
            onChange={(checked) => void handleToggle(checked)}
          />
        </div>

        {/* Connection facts a manual client config needs. */}
        <div>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 12 }}>
            {t('extensionSettings.connection')}
          </Text>
          {service?.running ? (
            <>
              {connectionRow(t('extensionSettings.port'), String(service.port))}
              {connectionRow(t('extensionSettings.wsUrl'), service.wsUrl, 'extensionSettings.wsUrlCopied')}
              {service?.enabled && (
                <div style={{ marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('extensionSettings.token')}
                  </Text>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    <Input.Password value={service?.token || ''} readOnly size="small" />
                    <Button size="small" onClick={() => copy(service?.token || '', 'extensionSettings.tokenCopied')}>
                      {t('extensionSettings.copy')}
                    </Button>
                    <Button size="small" danger loading={serviceBusy} onClick={() => void handleResetToken()}>
                      {t('extensionSettings.resetToken')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('extensionSettings.serviceNotRunning')}
            </Text>
          )}
        </div>

        {/* Connected clients. */}
        <div>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            {t('extensionSettings.clients')}
          </Text>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {service?.clients?.length ? (
              <Text data-extension-clients="">
                {service.clients.map((c) => `${c.clientId}${c.sessions > 0 ? `（${c.sessions}）` : ''}`).join('、')}
              </Text>
            ) : (
              <Text type="secondary">{t('extensionSettings.clientsEmpty')}</Text>
            )}
            <Button size="small" icon={<ReloadOutlined />} onClick={refreshService}>
              {t('extensionSettings.refresh')}
            </Button>
          </div>
        </div>

        {/* The download. */}
        <div>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            {t('extensionSettings.package')}
          </Text>
          <Space wrap>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={exportBusy}
              data-extension-export=""
              onClick={() => void handleExport()}
            >
              {t('extensionSettings.download')}
            </Button>
            {service?.extensionDir && (
              <Button
                icon={<FolderOpenOutlined />}
                onClick={() =>
                  window.electronAPI.openFolder(service.extensionDir!).catch((err: unknown) => {
                    notify.error(err instanceof Error ? err.message : String(err))
                  })
                }
              >
                {t('extensionSettings.openDir')}
              </Button>
            )}
          </Space>
          {service?.extensionDir && (
            <div style={{ marginTop: 8 }}>
              <Input value={service.extensionDir} readOnly size="small" />
            </div>
          )}
        </div>

        {/* Usage guide. */}
        <div>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            {t('extensionSettings.guide')}
          </Text>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(['g1', 'g2', 'g3', 'g4'] as const).map((step) => (
              <li key={step}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {withExtensionsLink(t(`extensionSettings.${step}`), openExtensionsPage)}
                </Text>
              </li>
            ))}
          </ol>
        </div>
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
      <Drawer title={<><ApiOutlined style={{ marginRight: 8 }} />{t('extensionSettings.title')}</>} open={open} onClose={onClose} size={440}>
        {body}
      </Drawer>
    </>
  )
}

export default ExtensionSettings
