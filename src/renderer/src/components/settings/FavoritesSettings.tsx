import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Drawer, Typography, Empty, Spin, message, Tag, Input } from 'antd'
import { StarOutlined, MessageOutlined, DeleteOutlined, CopyOutlined, CheckOutlined, DownOutlined, UpOutlined, DownloadOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import '@ant-design/x-markdown/themes/light.css'
import { useTranslation } from '../../i18n/useTranslation'

const { Text } = Typography

interface FavoriteItem {
  id: string
  messageId: string
  conversationId: string
  conversationTitle: string
  role: string
  content: string
  contentBlocks?: any
  createdAt: string
}

interface FavoritesSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

const PREVIEW_LENGTH = 120

function FavoritesSettings({ open, onClose, inline }: FavoritesSettingsProps): React.ReactElement {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [messageApi, contextHolder] = message.useMessage()
  const { t } = useTranslation()

  const filteredFavorites = useMemo(() => {
    if (!searchQuery.trim()) return favorites
    const q = searchQuery.toLowerCase()
    return favorites.filter(
      (item) =>
        item.content.toLowerCase().includes(q) ||
        (item.conversationTitle || '').toLowerCase().includes(q)
    )
  }, [favorites, searchQuery])

  const loadFavorites = useCallback(async () => {
    setLoading(true)
    try {
      const items = await window.electronAPI.listFavorites()
      setFavorites(items)
    } catch (err) {
      console.error('[FavoritesSettings] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      loadFavorites()
      setExpandedMap({})
      setCopiedId(null)
      setSearchQuery('')
    }
  }, [open, loadFavorites])

  const handleRemove = async (item: FavoriteItem) => {
    try {
      await window.electronAPI.removeFavorite(item.messageId)
      setFavorites((prev) => prev.filter((f) => f.messageId !== item.messageId))
      messageApi.success(t('favoritesDrawer.unfavorited'))
    } catch {
      messageApi.error(t('favoritesDrawer.unfavoriteFailed'))
    }
  }

  const handleCopy = async (item: FavoriteItem) => {
    try {
      await navigator.clipboard.writeText(item.content)
      setCopiedId(item.messageId)
      setTimeout(() => setCopiedId(null), 1500)
      messageApi.success(t('favoritesDrawer.copied'))
    } catch {
      messageApi.error(t('favoritesDrawer.copyFailed'))
    }
  }

  const handleExport = async (item: FavoriteItem) => {
    const title = item.conversationTitle || 'favorite'
    const safeName = title.replace(/[<>:"/\\|?*]/g, '_')
    try {
      const { filePath, canceled } = await window.electronAPI.showSaveDialog({
        defaultName: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) return
      const result = await window.electronAPI.writeFile({
        filePath,
        content: item.content
      })
      if (result.success) {
        messageApi.success(t('favoritesDrawer.exported'))
      } else {
        messageApi.error(t('favoritesDrawer.exportFailed'))
      }
    } catch {
      messageApi.error(t('favoritesDrawer.exportFailed'))
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const body = loading ? (
    <div style={{ textAlign: 'center', padding: 40 }}>
      <Spin />
    </div>
  ) : (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>{t('favoritesDrawer.title')}</Text>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        {t('favoritesDrawer.description')}
      </Text>
      <Input
        placeholder={t('favoritesDrawer.searchPlaceholder')}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        allowClear
        style={{ marginBottom: 12 }}
      />
      {filteredFavorites.length === 0 ? (
        <Empty description={searchQuery ? t('favoritesDrawer.searchEmpty') : t('favoritesDrawer.empty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filteredFavorites.map((item) => {
            const isExpanded = expandedMap[item.id] ?? false
            const isCollapsible = item.content.length > PREVIEW_LENGTH

            return (
              <div
                key={item.id}
                style={{
                  border: '1px solid #f0f0f0',
                  borderRadius: 8,
                  padding: '12px 16px',
                  background: '#fafafa'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                    <MessageOutlined style={{ color: '#999', fontSize: 12 }} />
                    <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      {item.conversationTitle || t('favoritesDrawer.untitled')}
                    </Text>
                    <Tag color={item.role === 'assistant' ? 'blue' : 'green'} style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                      {item.role === 'assistant' ? t('favoritesDrawer.ai') : t('favoritesDrawer.you')}
                    </Tag>
                  </div>
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button onClick={() => handleExport(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 14, padding: '2px 6px' }} title={t('favoritesDrawer.export')}><DownloadOutlined /></button>
                    <button onClick={() => handleCopy(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copiedId === item.messageId ? '#52c41a' : '#bbb', fontSize: 14, padding: '2px 6px' }} title={t('favoritesDrawer.copy')}>{copiedId === item.messageId ? <CheckOutlined /> : <CopyOutlined />}</button>
                    <button onClick={() => handleRemove(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', fontSize: 14, padding: '2px 4px' }} title={t('favoritesDrawer.unfavorite')} onMouseEnter={(e) => e.currentTarget.style.color = '#ff4d4f'} onMouseLeave={(e) => e.currentTarget.style.color = '#ccc'}><DeleteOutlined /></button>
                  </div>
                </div>
                {isExpanded ? (
                  <div className="x-markdown-light" style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6 }}>
                    <XMarkdown content={item.content} />
                  </div>
                ) : (
                  <div style={{ margin: '4px 0', fontSize: 13, color: '#333', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
                    {isCollapsible ? item.content.slice(0, PREVIEW_LENGTH) + '...' : item.content}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <Text style={{ fontSize: 11, color: '#bbb' }}>{new Date(item.createdAt).toLocaleString()}</Text>
                  {isCollapsible && (
                    <button onClick={() => toggleExpand(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 12, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {isExpanded ? <>{t('favoritesDrawer.collapse')} <UpOutlined style={{ fontSize: 10 }} /></> : <>{t('favoritesDrawer.expand')} <DownOutlined style={{ fontSize: 10 }} /></>}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{contextHolder}{body}</div>
  }

  return (
    <Drawer
      title={
        <span>
          <StarOutlined style={{ marginRight: 8 }} />
          {t('favoritesDrawer.title')}
        </span>
      }
      open={open}
      onClose={onClose}
      size={500}
    >
      {contextHolder}{body}
    </Drawer>
  )
}

export default FavoritesSettings
