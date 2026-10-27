// ── Advanced settings section (高级，原「数据与运行」) ──
// The power-user toggles: run-time keep-awake, LLM request dumping (+ its log
// directory), Git status injection and knowledge auto-compile. 启动/数据清理
// moved to 常规 (2026-09-21); the read-only directory rows are gone entirely —
// the workspace picker on 常规 is the one path surface left.
import React, { useEffect, useState } from 'react'
import { Button, Drawer, Input, Space, Switch, Typography } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { ROUTINE_WEBHOOK_UI } from '../../feature-flags'
import { notify } from '../../utils/notify'
import { parseProxyUrl, PROXY_URL_EXAMPLE } from '../../../../shared/proxy'
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
    void window.electronAPI
      .getDataPaths()
      .then((value) => {
        if (!disposed) setPaths(value)
      })
      .catch((err: unknown) => {
        if (!disposed) notify.error(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
    }
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

  // The webhook fields are text, so they commit on blur — a save per keystroke
  // would write the whole settings file per character (the toggles above flip
  // once; text does not).
  const [webhookUrl, setWebhookUrl] = useState(settings.notifications?.webhookUrl ?? '')
  const [webhookSecret, setWebhookSecret] = useState(settings.notifications?.webhookSecret ?? '')
  useEffect(() => {
    setWebhookUrl(settings.notifications?.webhookUrl ?? '')
    setWebhookSecret(settings.notifications?.webhookSecret ?? '')
  }, [settings.notifications?.webhookUrl, settings.notifications?.webhookSecret])
  const commitWebhook = (patch: { webhookUrl?: string; webhookSecret?: string }): void => {
    void save({ notifications: { ...settings.notifications, ...patch } })
  }

  // 重试码输入与 webhook 同款：文本在 blur 时一次性提交（每键一次整存不可
  // 接受）；提交前按主进程读取器的同一规则清洗（只留 400–599 整数、去重、
  // 升序），空串 = 清掉字段回到纯默认码表。外部值→编辑态的同步用「渲染期间
  // 调整 state」（react-hooks/set-state-in-effect 禁止 effect 内同步 setState）：
  // 数组引用变化时在渲染期重置，React 丢弃本次渲染结果立即重渲染，无级联。
  const [retryCodesText, setRetryCodesText] = useState((settings.llmRetryStatusCodes ?? []).join(', '))
  const [retryCodesSynced, setRetryCodesSynced] = useState(settings.llmRetryStatusCodes)
  if (settings.llmRetryStatusCodes !== retryCodesSynced) {
    setRetryCodesSynced(settings.llmRetryStatusCodes)
    setRetryCodesText((settings.llmRetryStatusCodes ?? []).join(', '))
  }
  const commitRetryCodes = (): void => {
    const codes = [
      ...new Set(
        retryCodesText
          .split(/[^0-9]+/)
          .filter(Boolean)
          .map(Number)
          .filter((c) => c >= 400 && c <= 599),
      ),
    ].sort((a, b) => a - b)
    const current = settings.llmRetryStatusCodes
    const changed = codes.length !== (current?.length ?? 0) || codes.some((c, i) => c !== current?.[i])
    if (changed) void save({ llmRetryStatusCodes: codes.length > 0 ? codes : undefined })
  }

  // 网络代理与重试码同款：blur 时一次性提交；提交前用主进程消费点的同一
  // 解析器（shared/proxy.parseProxyUrl）校验，非法地址就地报错不落盘——
  // 静默存进去只会让抓包抓了个寂寞。
  const [proxyUrlText, setProxyUrlText] = useState(settings.proxyUrl ?? '')
  const [proxySynced, setProxySynced] = useState(settings.proxyUrl)
  if (settings.proxyUrl !== proxySynced) {
    setProxySynced(settings.proxyUrl)
    setProxyUrlText(settings.proxyUrl ?? '')
  }
  const commitProxy = (): void => {
    const trimmed = proxyUrlText.trim()
    if (trimmed === (settings.proxyUrl ?? '')) return
    if (trimmed) {
      try {
        parseProxyUrl(trimmed)
      } catch (err) {
        notify.error(err instanceof Error ? err.message : String(err))
        return
      }
    }
    void save({ proxyUrl: trimmed || undefined })
  }

  const toggle = (key: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
      <div>
        <Text strong style={{ display: 'block', fontSize: 13 }}>
          {t(`dataRuntime.${key}`)}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t(`dataRuntime.${key}Help`)}
        </Text>
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
        {toggle('debugLlmRequests', settings.debugLlmRequests ?? false, (value) => {
          void save({ debugLlmRequests: value })
        })}
        <Button
          icon={<FolderOpenOutlined />}
          disabled={!paths?.dataDir}
          style={{ marginBottom: 16 }}
          onClick={() => {
            if (paths) void openFolder(`${paths.dataDir}/logs/llm-requests`)
          }}
        >
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
        {/* The settlement webhook surface is gated off (feature-flags
            ROUTINE_WEBHOOK_UI): stored url/secret keep working, the fields
            just stop rendering. */}
        {ROUTINE_WEBHOOK_UI && (
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ display: 'block', fontSize: 13 }}>
              {t('dataRuntime.routineWebhook')}
            </Text>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {t('dataRuntime.routineWebhookHelp')}
            </Text>
            <Input
              size="small"
              placeholder="https://…"
              value={webhookUrl}
              disabled={disabled}
              onChange={(e) => setWebhookUrl(e.target.value)}
              onBlur={() => {
                if (webhookUrl !== (settings.notifications?.webhookUrl ?? '')) commitWebhook({ webhookUrl })
              }}
            />
            <Input.Password
              size="small"
              style={{ marginTop: 6 }}
              placeholder={t('dataRuntime.routineWebhookSecret')}
              value={webhookSecret}
              disabled={disabled}
              onChange={(e) => setWebhookSecret(e.target.value)}
              onBlur={() => {
                if (webhookSecret !== (settings.notifications?.webhookSecret ?? '')) commitWebhook({ webhookSecret })
              }}
            />
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', fontSize: 13 }}>
            {t('dataRuntime.llmRetryCodes')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('dataRuntime.llmRetryCodesHelp')}
          </Text>
          <Input
            size="small"
            placeholder="408, 409"
            value={retryCodesText}
            disabled={disabled}
            onChange={(e) => setRetryCodesText(e.target.value)}
            onBlur={commitRetryCodes}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', fontSize: 13 }}>
            {t('dataRuntime.proxyUrl')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('dataRuntime.proxyUrlHelp')}
          </Text>
          <Input
            size="small"
            placeholder={PROXY_URL_EXAMPLE}
            value={proxyUrlText}
            disabled={disabled}
            onChange={(e) => setProxyUrlText(e.target.value)}
            onBlur={commitProxy}
          />
        </div>
        {toggle('proxyStrictSSL', settings.proxyStrictSSL !== false, (value) => {
          void save({ proxyStrictSSL: value })
        })}
      </Space>
    </>
  )
  return (
    <>
      {inline ? (
        body
      ) : (
        <Drawer title={t('dataRuntime.title')} open={open} onClose={onClose} size={440}>
          {body}
        </Drawer>
      )}
    </>
  )
}

export default DataRuntimeSettings
