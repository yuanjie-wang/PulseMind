// ── Memory settings section（v2，PLAN-memory-wiki M7 / E5，2026-10-25）──
// 三个分区，用户面前只有一个名词「记忆」：手动记忆（MEMORY.md 编辑）、
// 自动记忆（总开关卡片内含提取频率与「立即提取」）、已提取的记忆（浏览/搜索/删除，
// 经验归技能中心）。2026-11-12 用户裁定恢复「清空」按钮：只清自动提取的三类
// （preference/decision/fact，含退役与被取代的历史行），经验与手写 MEMORY.md 不动。
import React, { useState, useEffect, useCallback } from 'react'
import { Drawer, Typography, Button, Input, InputNumber, Space, Popconfirm } from 'antd'
import { BookOutlined, ThunderboltOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify, notifyFailure } from '../../utils/notify'
import { CLOCK_TICK_MS, describeRelativeTimeText } from '../../utils/relative-time'
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
  const [clearing, setClearing] = useState(false)
  // 清空后重挂载浏览件：面板的 load 只依赖 fixedType/typeFilter/submitted，
  // 宿主手里没有别的刷新把手，换 key 是最省事也最不会漏的一条。
  const [pagesKey, setPagesKey] = useState(0)
  // 上次自动记忆提取时刻：不读 useSettings 的启动快照——定时清扫由主进程随时
  // 落笔，快照必旧；面板打开时和手动提取后各自 getSettings 取新鲜值。
  const [lastSweepAt, setLastSweepAt] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const { t } = useTranslation()
  const { settings, saveSettings } = useSettings()
  const memoryOn = settings.memoryEnabled ?? true
  const intervalHours = settings.memoryExtractIntervalHours ?? 6
  const lastSweepText = describeRelativeTimeText(lastSweepAt, now, t)

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

  // 相对文案的时钟（sidebar/welcome 同款 60s 粒度）——面板开着不动，文案也要走。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const loadLastSweep = useCallback(async () => {
    try {
      const fresh = await window.electronAPI.getSettings()
      setLastSweepAt(fresh.memoryLastSweepAt)
    } catch { /* 读不出就不显示——辅助信息不值得报错弹窗 */ }
  }, [])

  useEffect(() => {
    if (open) void loadLastSweep()
  }, [open, loadLastSweep])

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
      // 主进程刚落笔了新的 memoryLastSweepAt——取新鲜值刷新展示行
      await loadLastSweep()
    } catch (err) {
      notifyFailure('memory.sweep', err, t('memoryDrawer.sweepFailed'))
    } finally {
      setSweeping(false)
    }
  }

  // 清空提取记忆（2026-11-12 用户裁定「记忆设置面板中，需要提供清空按钮」）：
  // 只清记忆三型——经验归技能中心、手写 MEMORY.md 都不动。连退役/被取代的历史行
  // 一并删除：面板把灰卡也画出来，只清活页会留一屏灰卡，看着像没清干净。
  const handleClearAll = async () => {
    setClearing(true)
    try {
      const removed = await window.electronAPI.clearMemoryPages(['preference', 'decision', 'fact'])
      notify.success(t('memoryPages.cleared', { count: removed }))
      setPagesKey((k) => k + 1)
    } catch (err) {
      notifyFailure('memory.clearAll', err, t('memoryPages.clearFailed'))
    } finally {
      setClearing(false)
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
        {/* 上次提取时刻（settings.memoryLastSweepAt，主进程 sweep 落笔）：相对文案
            与 sidebar/welcome 同一套 describeRelativeTimeText；早退不算跑，无记录
            =「尚未提取」。 */}
        <Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 12 }}>
          {lastSweepText ? t('memoryDrawer.lastSweep', { time: lastSweepText }) : t('memoryDrawer.lastSweepNever')}
        </Text>
      </FeatureSwitch>

      {/* ── 已提取的记忆（E5：内容归位设置面板；经验归技能中心不在过滤内）── */}
      <SettingCard
        title={t('memoryPages.browseTitle')}
        help={t('memoryPages.browseHelp')}
        extra={
          <Popconfirm
            title={t('memoryPages.clearConfirm')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={handleClearAll}
          >
            <Button danger size="small" icon={<DeleteOutlined />} loading={clearing}>
              {t('memoryPages.clearAll')}
            </Button>
          </Popconfirm>
        }
      >
        <MemoryPagesBrowser key={pagesKey} deletable />
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
