/**
 * 设置 → 语音输入（PLAN-voice-input §3.6 / M2）。
 *
 * 三张卡：引擎状态（随包版本/平台/自检）、模型管理（已装 + 导入/删除，导入
 * 走 VoiceGuideCard——场景 B 的运维视角：期望文件名 + sha256 + 指引链接都在
 * 卡上）、偏好（转写语言 hint，保存进 settings.voiceLanguage）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Drawer, Select, Space, Tag, Typography } from 'antd'
import { AudioOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { VoiceGuideCard } from './VoiceGuideCard'

const { Text } = Typography

interface VoiceStatePayload {
  engine: { dir: string; source: string; version: string; platform: string } | null
  engineError: string | null
  numThreads: number
  catalog: {
    family: string
    engineReq: string
    error: string | null
    models: Array<{
      modelId: string
      displayName: string
      version: string
      languages: string[]
      expectedZip: string
      zipSha256: string
      sizeText: string
      helpUrl: string
      installed: boolean
    }>
  }
}

interface VoiceSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

const LANG_OPTIONS = ['auto', 'zh', 'yue', 'en', 'ja', 'ko'] as const
const SOURCE_KEYS: Record<string, string> = {
  resources: 'voiceInput.engineSourcePackaged',
  dev: 'voiceInput.engineSourceDev',
  env: 'voiceInput.engineSourceEnv',
}

function VoiceSettingsBody(): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<VoiceStatePayload | null>(null)
  const [voiceLanguage, setVoiceLanguage] = useState<string>('auto')

  const refresh = useCallback((): void => {
    window.electronAPI
      .asrGetState()
      .then(setState)
      .catch((err: unknown) => console.warn('[VoiceSettings] state refresh failed:', err))
    window.electronAPI
      .getSettings()
      .then((s) => setVoiceLanguage(s.voiceLanguage ?? 'auto'))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    // 导入/删除广播 → 状态卡与模型列表即时翻面
    return window.electronAPI.onAsrModelsChanged(refresh)
  }, [refresh])

  const changeLanguage = useCallback((next: string): void => {
    setVoiceLanguage(next)
    void window.electronAPI
      .getSettings()
      .then((s) => window.electronAPI.setSettings({ ...s, voiceLanguage: next as 'auto' }))
      .catch((err: unknown) => console.warn('[VoiceSettings] save failed:', err))
  }, [])

  const installed = (state?.catalog.models ?? []).filter((m) => m.installed)

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }} data-voice-settings="">
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('voiceInput.settingsDesc')}
      </Text>

      {/* 引擎状态卡 */}
      <div>
        <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
          <AudioOutlined style={{ marginRight: 6 }} />
          {t('voiceInput.engineTitle')}
        </Text>
        {state?.engine ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tag>{t(SOURCE_KEYS[state.engine.source] ?? state.engine.source)}</Tag>
            <Tag>
              {t('voiceInput.engineVersion')}: {state.engine.version}
            </Tag>
            <Tag>{state.engine.platform}</Tag>
            <Tag>{state.numThreads} threads</Tag>
          </div>
        ) : (
          <Text type="danger" style={{ fontSize: 12 }}>
            {t('voiceInput.engineError')}：{state?.engineError ?? '—'}
          </Text>
        )}
      </div>

      {/* 模型管理卡：引导卡承载导入（运维视角的文件名/sha256/指引） */}
      <div>
        <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
          {t('voiceInput.installedModels')}
        </Text>
        {installed.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {installed.map((m) => (
              <div key={m.modelId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Text style={{ fontSize: 12 }}>{m.displayName}</Text>
                <Tag>
                  {t('voiceInput.modelVersion')}: {m.version}
                </Tag>
              </div>
            ))}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            {t('voiceInput.noModels')}
          </Text>
        )}
        <VoiceGuideCard models={state?.catalog.models} engineError={state?.engineError} onChanged={refresh} allowRemove />
      </div>

      {/* 支持的模型包（清单全列表，安装态打勾） */}
      {(state?.catalog.models ?? []).length > 0 && (
        <div>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            {t('voiceInput.supportedModels')}
          </Text>
          {(state?.catalog.models ?? []).map((m) => (
            <div key={m.modelId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              {m.installed && <Text style={{ color: 'var(--pm-success, #38a00d)' }}>✓</Text>}
              <Text style={{ fontSize: 12 }}>{m.displayName}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {m.sizeText}
              </Text>
            </div>
          ))}
        </div>
      )}

      {/* 偏好：转写语言 hint */}
      <div>
        <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
          {t('voiceInput.languageHint')}
        </Text>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Select
            value={voiceLanguage}
            onChange={changeLanguage}
            size="small"
            style={{ width: 160 }}
            options={LANG_OPTIONS.map((l) => ({ value: l, label: l === 'auto' ? t('voiceInput.languageAuto') : l }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('voiceInput.languageHintDesc')}
          </Text>
        </div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          {t('voiceInput.shortcutHint')}
        </Text>
      </div>
    </Space>
  )
}

function VoiceSettings({ open, onClose, inline }: VoiceSettingsProps): React.ReactElement {
  const { t } = useTranslation()
  const body = (
    <>
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 16 }}>
          {t('voiceInput.settingsTitle')}
        </Text>
      </div>
      <VoiceSettingsBody />
    </>
  )
  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{body}</div>
  }
  return (
    <Drawer title={t('voiceInput.settingsTitle')} open={open} onClose={onClose} size={440}>
      {body}
    </Drawer>
  )
}

export default VoiceSettings
