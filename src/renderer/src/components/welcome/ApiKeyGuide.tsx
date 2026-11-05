// ── API key guide (2026-11-04 用户裁定「提升下配置密钥的引导的设计感，现在像块豆腐干」) ──
// 未配置密钥时 welcome 页的引导卡：顶替原来的 warn 色方块。语言沿用
// Composer/项目卡那一套——veil 1px 边框 + glass 阴影 + 16 圆角 + elevated
// 实底（不做 glass：welcome 页没有需要透出的内容，实底更干净，也免掉
// Win/其余平台的 blur 分支），左侧 KeyOutlined 图标座（--pm-link-bg 淡蓝
// wash）、标题/说明两行、右侧主按钮。
// 两个宿主共用这一份：主 welcome（WelcomeContent）与 dock 的窄欢迎面
// （ChatBody）——同一张引导卡各写一遍必然漂移。compact = 窄面纵向排布
// （图标行 + 整宽按钮），横向卡片在 380px 的 dock 里会把说明压成一条竖缝。
// 2026-11-05 加「导入模板包」次级入口：一次性模板 zip（整份 settings.json +
// 可选 skills/）导入走主进程 template:import；成功后无需手动刷新——主进程
// 广播 SETTINGS_CHANGED，useAppSettings 自动更新 hasApiKey，本卡随之退场。

import React from 'react'
import { Button, App as AntdApp } from 'antd'
import { ArrowRightOutlined, ImportOutlined, KeyOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'

export function ApiKeyGuide({ compact }: { compact?: boolean }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const { message: antdMessage } = AntdApp.useApp()
  const openSettings = () => navigate({ kind: 'settings', settingsTab: 'settings' })

  // 模板包导入：一次性入口（团队从配置好的机器拷 settings.json + 技能进
  // zip）。settings 落盘后的 hasApiKey 翻转由广播链驱动，这里只反馈结果。
  const importTemplate = async () => {
    try {
      const result = await window.electronAPI.importTemplate()
      if (!result) return
      if (result.settingsApplied || result.skills.imported.length > 0) {
        const skillNote = result.skills.imported.length > 0
          ? ' ' + t('welcome.templateImportSkills', { count: result.skills.imported.length })
          : ''
        antdMessage.success(t('welcome.templateImportSuccess') + skillNote)
      } else {
        antdMessage.warning(t('welcome.templateImportEmpty'))
      }
      const issues = [...result.warnings, ...result.skills.errors]
      if (issues.length > 0) {
        antdMessage.warning(issues.join('；'), 6)
      }
    } catch (err) {
      antdMessage.error(t('welcome.templateImportFailed'))
      console.error('[ApiKeyGuide] template import failed:', err)
    }
  }

  const badge = (
    <div
      style={{
        width: compact ? 36 : 44,
        height: compact ? 36 : 44,
        borderRadius: compact ? 10 : 13,
        background: 'var(--pm-link-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <KeyOutlined style={{ fontSize: compact ? 16 : 19, color: 'var(--pm-link)' }} />
    </div>
  )
  const copy = (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left' }}>
      <span style={{ fontSize: compact ? 14 : 15, fontWeight: 600, lineHeight: '21px', color: 'var(--pm-text-strong)' }}>{t('welcome.noApiKeyTitle')}</span>
      <span style={{ fontSize: 13, lineHeight: '19px', color: 'var(--pm-text-muted)' }}>{t('welcome.noApiKeyBody')}</span>
    </div>
  )
  const importButton = (
    <Button
      shape="round"
      onClick={importTemplate}
      data-pm-template-import
      icon={<ImportOutlined style={{ fontSize: 12 }} />}
      style={compact ? { width: '100%' } : { flexShrink: 0 }}
    >
      {t('welcome.importTemplate')}
    </Button>
  )
  const action = (
    <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8, flexShrink: 0 }}>
      <Button type="primary" shape="round" onClick={openSettings} style={compact ? { width: '100%' } : { flexShrink: 0 }}>
        {t('welcome.configureApiKey')}
        <ArrowRightOutlined style={{ fontSize: 12, marginLeft: 6 }} />
      </Button>
      {importButton}
    </div>
  )

  return (
    <div
      data-pm-api-key-guide
      style={{
        display: 'flex',
        flexDirection: compact ? 'column' : 'row',
        alignItems: compact ? 'stretch' : 'center',
        gap: compact ? 12 : 16,
        padding: compact ? '14px 16px' : '18px 20px',
        borderRadius: 16,
        background: 'var(--pm-elevated)',
        border: '1px solid var(--pm-border-veil)',
        boxShadow: 'var(--pm-shadow-glass)',
        textAlign: 'left',
        flexShrink: 0,
      }}
    >
      {compact ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {badge}
            {copy}
          </div>
          {action}
        </>
      ) : (
        <>
          {badge}
          {copy}
          {action}
        </>
      )}
    </div>
  )
}
