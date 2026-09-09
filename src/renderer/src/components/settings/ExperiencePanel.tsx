import React, { useCallback, useEffect, useState } from 'react'
import { Drawer, Modal, Tag, Typography, Alert, Button, Tooltip, Popconfirm, Empty, Spin } from 'antd'
import { DeleteOutlined, EyeOutlined, ExperimentOutlined } from '@ant-design/icons'
import { MAX_EXPERIENCES } from '../../../../shared/types/experience-types'
import type { ExperienceRecord } from '../../../../shared/types/experience-types'

const { Text, Paragraph } = Typography

const CATEGORY_COLORS: Record<string, string> = {
  code: 'blue',
  architecture: 'purple',
  user_pref: 'green',
  decision: 'orange',
  general: 'default'
}

interface ExperiencePanelProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

function ExperiencePanel({ open, onClose, inline }: ExperiencePanelProps): React.ReactElement {
  const [experiences, setExperiences] = useState<ExperienceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [viewName, setViewName] = useState<string | null>(null)
  const [viewContent, setViewContent] = useState<string>('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setExperiences(await window.electronAPI.listExperiences())
    } catch (err) {
      console.error('[ExperiencePanel] list failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, no cascading renders
    refresh()
    return window.electronAPI.onExperiencesChanged(() => {
      refresh()
    })
  }, [refresh])

  const openView = useCallback(async (name: string) => {
    setViewName(name)
    setViewContent('')
    try {
      const content = await window.electronAPI.readExperienceRecord(name)
      setViewContent(content ?? '(empty)')
      window.electronAPI.touchExperienceRecord(name).then(() => refresh()).catch(() => {})
    } catch (err) {
      setViewContent(`(read failed: ${String(err)})`)
    }
  }, [refresh])

  const handleDelete = useCallback(async (name: string) => {
    try {
      await window.electronAPI.deleteExperienceRecord(name)
      await refresh()
    } catch (err) {
      console.error('[ExperiencePanel] delete failed:', err)
    }
  }, [refresh])

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Text strong style={{ fontSize: 16 }}>经验</Text>
        <Tooltip title="刷新列表">
          <Button size="small" icon={<ExperimentOutlined />} onClick={refresh} />
        </Tooltip>
      </div>
      <Alert
        type="info"
        showIcon
        style={{ fontSize: 12, marginBottom: 12 }}
        message={`最多保留 ${MAX_EXPERIENCES} 条经验，超出后按最近触发时间（LRU）自动淘汰最久未使用的条目。查看全文即记录一次触发。`}
      />
      {loading && experiences.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>
      ) : experiences.length === 0 ? (
        <Empty description="暂无经验" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 24 }} />
      ) : (
        experiences.map((exp) => (
          <div
            key={exp.name}
            style={{
              border: '1px solid #f0f0f0', borderRadius: 8, padding: '10px 12px', marginBottom: 8,
              display: 'flex', flexDirection: 'column', gap: 4
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Text strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{exp.title}</Text>
                <Tag color={CATEGORY_COLORS[exp.category] ?? 'default'} style={{ marginInlineEnd: 0, fontSize: 11 }}>{exp.category}</Tag>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <Tooltip title="查看全文（记录触发）">
                  <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => openView(exp.name)} />
                </Tooltip>
                <Popconfirm title="删除该经验？" onConfirm={() => handleDelete(exp.name)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            </div>
            <Paragraph
              style={{ margin: 0, fontSize: 12, color: '#888' }}
              ellipsis={{ rows: 2 }}
            >
              {exp.description}
            </Paragraph>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#aaa' }}>
              <span>创建 {exp.createdAt}</span>
              <span>{exp.lastUsedAt ? `最近触发 ${exp.lastUsedAt}` : '从未触发'}</span>
              <span>触发 {exp.useCount} 次</span>
            </div>
            {exp.triggers && exp.triggers.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {exp.triggers.map((kw) => (
                  <span key={kw} style={{ fontSize: 11, color: '#1677ff', background: 'rgba(22,119,255,0.08)', borderRadius: 4, padding: '1px 6px' }}>{kw}</span>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </>
  )

  return (
    <>
      {inline ? (
        <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
      ) : (
        <Drawer
          title={<span><ExperimentOutlined style={{ marginRight: 8 }} />经验</span>}
          open={open}
          onClose={onClose}
          size={420}
        >
          {content}
        </Drawer>
      )}
      <Modal
        title={viewName}
        open={viewName !== null}
        onCancel={() => setViewName(null)}
        footer={null}
        width={640}
      >
        <pre style={{ maxHeight: 480, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fafafa', padding: 12, borderRadius: 8 }}>
          {viewContent}
        </pre>
      </Modal>
    </>
  )
}

export default ExperiencePanel
