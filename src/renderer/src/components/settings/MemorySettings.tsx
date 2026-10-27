// ── Memory settings section（v2，PLAN-memory-wiki M7 / E5，2026-10-25）──
// 三个分区，用户面前只有一个名词「记忆」：手动记忆（MEMORY.md 编辑）、
// 自动记忆（总开关卡片内含提取频率与「立即提取」）、已提取的记忆（浏览/搜索/删除，
// 经验归技能中心）。旧的提取记忆列表/清空随旧表冻结一并退役。
import React, { useState, useEffect, useCallback } from 'react'
import { Drawer, Typography, Button, Input, InputNumber, Space } from 'antd'
import { BookOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify, notifyFailure } from '../../utils/notify'
import { useSettings } from '../../hooks/SettingsContext'
import { MemoryManager } from '../../memory/MemoryManager'
import FeatureSwitch, { SettingCard } from './FeatureSwitch'
import MemoryPagesBrowser from '../knowledge/MemoryPagesPanel'

const { Text } = Typography

interface MemorySettingsProps {
  open: boolean
  onClose: () => void
  memoryManager: MemoryManager
  inline?: boolean
}

function MemorySettings({ open, onClose, memoryManager, inline }: MemorySettingsProps): React.ReactElement {
  const [mdContent, setMdContent] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const { t } = useTranslation()
  const { settings, saveSettings } = useSettings()
  const memoryOn = settings.memoryEnabled ?? true
  const intervalHours = settings.memoryExtractIntervalHours ?? 6

  const loadMd = useCallback(async () => {
    try {
      setMdContent(await memoryManager.getMemoryMd())
    } catch (err) {
      notifyFailure('memory.loadMd', err, t('memoryDrawer.loadFailed'))
    }
  }, [memoryManager, t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, no cascading renders
    if (open) loadMd()
  }, [open, loadMd])

  const handleSaveMd = async () => {
    await memoryManager.saveMemoryMd(mdContent)
    notify.success(t('memoryDrawer.manualMemoriesSaved'))
  }

  const handleSweepNow = async () => {
    setSweeping(true)
    try {
      const res = await window.electronAPI.runMemorySweepNow()
      if (res.error) notify.error(res.error)
      else notify.success(t('memoryDrawer.sweepDone', { count: res.extracted }))
    } catch (err) {
      notifyFailure('memory.sweep', err, t('memoryDrawer.sweepFailed'))
    } finally {
      setSweeping(false)
    }
  }

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>{t('memoryDrawer.title')}</Text>

      {/* ── 手动记忆（MEMORY.md）── */}
      <SettingCard
        title={t('memoryDrawer.manualMemories')}
        help={t('memoryDrawer.manualMemoriesHelp')}
        extra={<Button type="primary" size="small" onClick={handleSaveMd}>{t('memoryDrawer.save')}</Button>}
      >
        <Input.TextArea
          value={mdContent}
          onChange={(e) => setMdContent(e.target.value)}
          rows={6}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </SettingCard>

      {/* ── 自动记忆：总开关 + 提取频率（PLAN-memory-wiki M2c：主时机 = 定时清扫）── */}
      <FeatureSwitch
        label={t('memoryDrawer.masterSwitch')}
        help={t('memoryDrawer.masterSwitchHelp')}
        checked={memoryOn}
        onChange={(checked) => saveSettings({ ...settings, memoryEnabled: checked })}
      >
        <Space wrap align="center" size={[8, 8]}>
          <Text style={{ fontSize: 13 }}>{t('memoryDrawer.extractInterval')}</Text>
          <InputNumber
            min={0}
            max={168}
            step={1}
            value={intervalHours}
            onChange={(v) => saveSettings({ ...settings, memoryExtractIntervalHours: typeof v === 'number' ? v : 0 })}
            style={{ width: 90 }}
            addonAfter={t('memoryDrawer.hoursUnit')}
          />
          <Button size="small" icon={<ThunderboltOutlined />} loading={sweeping} onClick={handleSweepNow}>
            {t('memoryDrawer.sweepNow')}
          </Button>
        </Space>
        <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
          {t('memoryDrawer.extractIntervalHelp')}
        </Text>
      </FeatureSwitch>

      {/* ── 已提取的记忆（E5：内容归位设置面板；经验归技能中心不在过滤内）── */}
      <SettingCard title={t('memoryPages.browseTitle')} help={t('memoryPages.browseHelp')}>
        <MemoryPagesBrowser deletable />
      </SettingCard>
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{body}</div>
  }

  return (
    <Drawer
      title={
        <span>
          <BookOutlined style={{ marginRight: 8 }} />
          {t('memoryDrawer.title')}
        </span>
      }
      open={open}
      onClose={onClose}
      size={500}
    >
      {body}
    </Drawer>
  )
}

export default MemorySettings
