// ── Memory settings section ──
// 设置 → 记忆: the memoryEnabled master switch (FeatureSwitch, mirrored to the
// shared MemoryManager by App.tsx / settings.handler) plus manual memory CRUD
// and search against the live MemoryManager instance.
import React, { useState, useEffect, useCallback } from 'react'
import { Drawer, Typography, Space, Button, Tag, Empty, Popconfirm, Input, message, Spin, Card } from 'antd'
import { BookOutlined, ClearOutlined, CopyOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { MemoryManager } from '../../memory/MemoryManager'
import type { MemoryEntry } from '../../memory/types'
import FeatureSwitch from './FeatureSwitch'

const { Text, Paragraph } = Typography

interface MemorySettingsProps {
  open: boolean
  onClose: () => void
  memoryManager: MemoryManager
  inline?: boolean
}

const CATEGORY_COLORS: Record<string, string> = {
  code: 'blue',
  architecture: 'purple',
  user_pref: 'green',
  decision: 'orange',
  general: 'default',
  experience: 'cyan'
}

function MemorySettings({ open, onClose, memoryManager, inline }: MemorySettingsProps): React.ReactElement {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mdContent, setMdContent] = useState('')
  const [messageApi, contextHolder] = message.useMessage()
  const { t } = useTranslation()
  const { settings, saveSettings } = useSettings()
  // 设置 → 记忆 master switch: gates auto extraction + prompt injection.
  const memoryOn = settings.memoryEnabled ?? true

  const TYPE_LABELS: Record<string, string> = {
    fact: t('memoryDrawer.type.fact'),
    decision: t('memoryDrawer.type.decision'),
    preference: t('memoryDrawer.type.preference'),
    auto: t('memoryDrawer.type.auto'),
    manual: t('memoryDrawer.type.manual'),
    experience: t('memoryDrawer.type.experience')
  }

  const CATEGORY_LABELS: Record<string, string> = {
    general: t('memoryDrawer.category.general'),
    code: t('memoryDrawer.category.code'),
    architecture: t('memoryDrawer.category.architecture'),
    user_pref: t('memoryDrawer.category.userPref'),
    decision: t('memoryDrawer.category.decision'),
    experience: t('memoryDrawer.category.experience')
  }

  const loadMemories = useCallback(async () => {
    setLoading(true)
    const t0 = performance.now()
    try {
      const all = await memoryManager.listMemories()
      console.log(`[MemoryPanel] loadMemories round-trip: ${(performance.now() - t0).toFixed(1)}ms, ${all.length} items`)
      setMemories(all.filter((m) => m.type !== 'experience'))
    } catch (err) {
      console.error('[MemorySettings] Failed to load memories:', err)
    } finally {
      setLoading(false)
    }
  }, [memoryManager])

  const loadMd = useCallback(async () => {
    const t0 = performance.now()
    try {
      const content = await memoryManager.getMemoryMd()
      console.log(`[MemoryPanel] loadMd round-trip: ${(performance.now() - t0).toFixed(1)}ms`)
      setMdContent(content)
    } catch (err) {
      console.error('[MemorySettings] Failed to load Manual Memories:', err)
    }
  }, [memoryManager])

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, no cascading renders
      loadMemories()
      loadMd()
    }
  }, [open, loadMemories, loadMd, memoryManager])

  const handleSearch = async (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      loadMemories()
      return
    }
    setLoading(true)
    try {
      const results = await memoryManager.searchMemories({ query, limit: 50 })
      setMemories(results)
    } catch (err) {
      console.error('[MemorySettings] Search failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await memoryManager.deleteMemory(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
      messageApi.success(t('memoryDrawer.memoryDeleted'))
    } catch {
      messageApi.error(t('memoryDrawer.memoryDeleteFailed'))
    }
  }

  const handleClearAll = async () => {
    let deleted = 0
    for (const mem of memories) {
      await memoryManager.deleteMemory(mem.id)
      deleted++
    }
    setMemories([])
    messageApi.success(t('memoryDrawer.clearDeleted', { count: deleted }))
  }

  const handleSaveMd = async () => {
    await memoryManager.saveMemoryMd(mdContent)
    messageApi.success(t('memoryDrawer.manualMemoriesSaved'))
  }

  const body = (
    <>
      {contextHolder}

      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>{t('memoryDrawer.title')}</Text>

      {/* ── Master switch (设置 → 记忆) ── */}
      <FeatureSwitch
        label={t('memoryDrawer.masterSwitch')}
        help={t('memoryDrawer.masterSwitchHelp')}
        checked={memoryOn}
        onChange={(checked) => saveSettings({ ...settings, memoryEnabled: checked })}
      />

      {/* ── Manual Memories Editor ── */}
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('memoryDrawer.manualMemories')}</Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('memoryDrawer.manualMemoriesHelp')}
        </Text>
        <Input.TextArea
          value={mdContent}
          onChange={(e) => setMdContent(e.target.value)}
          rows={6}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Button
          type="primary"
          size="small"
          style={{ marginTop: 8 }}
          onClick={handleSaveMd}
        >
          {t('memoryDrawer.save')}
        </Button>
      </div>

      {/* ── Extracted Memories Section ── */}
      <div style={{ marginBottom: 12 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('memoryDrawer.extractedMemories')}</Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('memoryDrawer.extractedMemoriesHelp')}
        </Text>
      </div>

      {/* ── Search ── */}
      <div style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('memoryDrawer.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadMemories} />
        </Space.Compact>
      </div>

      {/* ── Memory count & actions ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('memoryDrawer.count', { count: memories.length })}
          </Text>
          {memories.length > 40 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('memoryDrawer.compressWarning')}
            </Text>
          )}
        </Space>
        <Space size={4}>
          <Popconfirm
            title={t('memoryDrawer.clearConfirm')}
            description={`这将删除全部 ${memories.length} 条记忆。`}
            onConfirm={handleClearAll}
            okText={t('memoryDrawer.deleteOk')}
            okButtonProps={{ danger: true }}
          >
            {memories.length > 0 && (
              <Button type="text" danger size="small" icon={<ClearOutlined />}>
                {t('memoryDrawer.clearAll')}
              </Button>
            )}
          </Popconfirm>
        </Space>
      </div>

      {/* ── Memory cards ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : memories.length === 0 ? (
        <Empty
          description={t('memoryDrawer.empty')}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {memories.map((item) => (
            <Card key={item.id} size="small" style={{ borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4, marginBottom: 6 }}>
                <Space size={4} wrap style={{ minWidth: 0 }}>
                  <Tag color={CATEGORY_COLORS[item.category] || 'default'} style={{ marginInlineEnd: 0 }}>
                    {CATEGORY_LABELS[item.category] || item.category}
                  </Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>{TYPE_LABELS[item.type] || item.type}</Tag>
                </Space>
                <Space size={0} style={{ flexShrink: 0 }}>
                  <Button type="text" size="small" icon={<CopyOutlined style={{ color: '#bbb' }} />} onClick={() => {
                    navigator.clipboard.writeText(item.content)
                    messageApi.success(t('common.copy'))
                  }} />
                  <Popconfirm
                    title={t('memoryDrawer.deleteTitle')}
                    onConfirm={() => handleDelete(item.id)}
                    okText={t('memoryDrawer.deleteOk')}
                    okButtonProps={{ danger: true }}
                    cancelText={t('memoryDrawer.deleteCancel')}
                  >
                    <Button type="text" size="small" icon={<DeleteOutlined style={{ color: '#bbb' }} />} />
                  </Popconfirm>
                </Space>
              </div>
              <Paragraph style={{ margin: 0, fontSize: 13 }} ellipsis={{ rows: 3, expandable: true }}>
                {item.content}
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                {(() => {
                  const d = new Date(item.createdAt)
                  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
                })()}
              </Text>
            </Card>
          ))}
        </div>
      )}
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
