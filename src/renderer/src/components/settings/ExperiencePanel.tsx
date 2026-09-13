// ── Experience settings section ──
// 设置 → 经验: the experienceEnabled master switch plus the LRU experience
// record list (max MAX_EXPERIENCES) with view/delete. Rendered inline in the
// settings page next to 记忆.
import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Tag, Typography, Alert, Button, Tooltip, Popconfirm, Empty, Spin, Card } from 'antd'
import { DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import { MAX_EXPERIENCES } from '../../../../shared/types/experience-types'
import type { ExperienceRecord } from '../../../../shared/types/experience-types'
import { useSettings } from '../../hooks/SettingsContext'
import FeatureSwitch from './FeatureSwitch'

const { Text, Paragraph } = Typography

const CATEGORY_COLORS: Record<string, string> = {
  code: 'blue',
  architecture: 'purple',
  user_pref: 'green',
  decision: 'orange',
  general: 'default'
}

/** 设置 → 经验：经验列表（原能力中心面板，连同其全局开关一并迁入）。 */
const ExperiencePanel = function ExperiencePanel(): React.ReactElement {
  const { settings, saveSettings } = useSettings()
  const experienceOn = settings.experienceEnabled ?? true
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
      {/* Section title + refresh — matches the 记忆 section's title row. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Text strong style={{ fontSize: 16 }}>经验</Text>
        <Tooltip title="重新加载经验列表">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refresh()}>刷新</Button>
        </Tooltip>
      </div>
      <FeatureSwitch
        label="自动沉淀经验"
        help="开启后，符合条件（任务复杂、有纠错或非平凡流程）的对话结束时会自动提炼经验；关闭后不再自动沉淀，已有经验保留可查看。"
        checked={experienceOn}
        onChange={(checked) => saveSettings({ ...settings, experienceEnabled: checked })}
      />
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {experiences.map((exp) => (
            <Card
              key={exp.name}
              size="small"
              hoverable
              style={{ borderRadius: 10 }}
              onClick={() => openView(exp.name)}
              title={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{exp.title}</span>
                  <Tag color={CATEGORY_COLORS[exp.category] ?? 'default'} style={{ marginInlineEnd: 0, fontSize: 11, flexShrink: 0 }}>{exp.category}</Tag>
                </span>
              }
              extra={
                <span style={{ display: 'inline-flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                  <Tooltip title="查看全文（记录触发）">
                    <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => openView(exp.name)} />
                  </Tooltip>
                  <Popconfirm title="删除该经验？" onConfirm={() => handleDelete(exp.name)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </span>
              }
            >
              <Paragraph
                style={{ margin: 0, fontSize: 12, color: '#888' }}
                ellipsis={{ rows: 2 }}
              >
                {exp.description}
              </Paragraph>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#aaa', marginTop: 6 }}>
                <span>创建 {exp.createdAt}</span>
                <span>{exp.lastUsedAt ? `最近触发 ${exp.lastUsedAt}` : '从未触发'}</span>
                <span>触发 {exp.useCount} 次</span>
              </div>
              {exp.triggers && exp.triggers.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {exp.triggers.map((kw) => (
                    <span key={kw} style={{ fontSize: 11, color: '#1677ff', background: 'rgba(22,119,255,0.08)', borderRadius: 4, padding: '1px 6px' }}>{kw}</span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )

  return (
    <>
      <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
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
