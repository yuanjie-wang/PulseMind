// ── Experience settings section ──
// 设置 → 经验: the experienceEnabled master switch plus the LRU experience
// record list (max MAX_EXPERIENCES) with view/delete. Rendered inline in the
// settings page next to 记忆.
import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Tag, Typography, Alert, Button, Tooltip, Popconfirm, Empty, Spin, Card, message } from 'antd'
import { ClearOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import { MAX_EXPERIENCES } from '../../../../shared/types/experience-types'
import type { ExperienceRecord } from '../../../../shared/types/experience-types'
import { useSettings } from '../../hooks/SettingsContext'
import FeatureSwitch from './FeatureSwitch'

const { Text, Paragraph } = Typography

// 「不再出现」的关闭记忆：同一形态复用 SkillsPanel 的 localStorage 模式。
const DISMISS_TIP_KEY = 'pulsemind_dismissed_experience_tip'

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
  // 伴随脚本（PLAN-experience-scripts 1.7）：面板只读查看，无编辑无运行按钮。
  const [viewRecord, setViewRecord] = useState<ExperienceRecord | null>(null)
  const [scriptContent, setScriptContent] = useState<{ path: string; content: string } | null>(null)
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(DISMISS_TIP_KEY) === 'true')

  const dismissTip = useCallback(() => {
    localStorage.setItem(DISMISS_TIP_KEY, 'true')
    setTipDismissed(true)
  }, [])

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

  // 淘汰可见（PLAN-experience-scripts 1.6）：Manager 在保存挤掉含脚本的经验
  // 时派发 window 事件，这里弹一条 antd message——无声淘汰丢掉的是已验证的
  // 自动化，这个代价必须可见。
  useEffect(() => {
    const onEvicted = (e: Event): void => {
      const rec = (e as CustomEvent).detail?.record as { name?: string; files?: string[] } | undefined
      if (rec?.files?.length) {
        message.warning(`已淘汰包含脚本的经验：${rec.name ?? ''}`)
      }
    }
    window.addEventListener('pm-experience-evicted', onEvicted)
    return () => window.removeEventListener('pm-experience-evicted', onEvicted)
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
    setScriptContent(null)
    setViewRecord(experiences.find((e) => e.name === name) ?? null)
    try {
      const content = await window.electronAPI.readExperienceRecord(name)
      setViewContent(content ?? '(empty)')
      window.electronAPI.touchExperienceRecord(name).then(() => refresh()).catch(() => {})
    } catch (err) {
      setViewContent(`(read failed: ${String(err)})`)
    }
  }, [refresh, experiences])

  const openScript = useCallback(async (name: string, relPath: string) => {
    setScriptContent({ path: relPath, content: '' })
    try {
      const content = await window.electronAPI.readExperienceFile(name, relPath)
      setScriptContent(content === null
        ? { path: relPath, content: '(读取失败：文件不存在或路径越界)' }
        : { path: relPath, content })
    } catch (err) {
      setScriptContent({ path: relPath, content: `(读取失败：${String(err)})` })
    }
  }, [])

  const handleDelete = useCallback(async (name: string) => {
    try {
      await window.electronAPI.deleteExperienceRecord(name)
      await refresh()
    } catch (err) {
      console.error('[ExperiencePanel] delete failed:', err)
    }
  }, [refresh])

  const handleClearAll = useCallback(async () => {
    try {
      await window.electronAPI.clearExperiences()
      await refresh()
    } catch (err) {
      console.error('[ExperiencePanel] clear failed:', err)
    }
  }, [refresh])

  const content = (
    <>
      {/* Section title + clear/refresh — the title row the 记忆 section uses. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>
        <Text strong style={{ fontSize: 16 }}>经验</Text>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {experiences.length > 0 && (
            <Popconfirm
              title="清空全部经验？"
              description={`这将删除全部 ${experiences.length} 条经验。`}
              onConfirm={handleClearAll}
              okText="清空"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button type="text" danger size="small" icon={<ClearOutlined />}>
                清空
              </Button>
            </Popconfirm>
          )}
          <Tooltip title="重新加载经验列表">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refresh()}>刷新</Button>
          </Tooltip>
        </span>
      </div>
      <FeatureSwitch
        label="自动沉淀经验"
        help="开启后，符合条件（任务复杂、有纠错或非平凡流程）的对话结束时会自动提炼经验；关闭后不再自动沉淀，已有经验保留可查看。"
        checked={experienceOn}
        onChange={(checked) => saveSettings({ ...settings, experienceEnabled: checked })}
      />
      {!tipDismissed && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={dismissTip}
          style={{ fontSize: 12, marginBottom: 12 }}
          title={`最多保留 ${MAX_EXPERIENCES} 条经验，超出后按最近触发时间（LRU）自动淘汰最久未使用的条目。查看全文即记录一次触发。`}
        />
      )}
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
                  {exp.files && exp.files.length > 0 && (
                    <Tag color="geekblue" style={{ marginInlineEnd: 0, fontSize: 11, flexShrink: 0 }}>
                      含脚本 {exp.files.length}
                    </Tag>
                  )}
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
                style={{ margin: 0, fontSize: 12, color: 'var(--pm-text-quiet)' }}
                ellipsis={{ rows: 2 }}
              >
                {exp.description}
              </Paragraph>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--pm-text-soft)', marginTop: 6 }}>
                <span>创建 {exp.createdAt}</span>
                <span>{exp.lastUsedAt ? `最近触发 ${exp.lastUsedAt}` : '从未触发'}</span>
                <span>触发 {exp.useCount} 次</span>
              </div>
              {exp.triggers && exp.triggers.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {exp.triggers.map((kw) => (
                    <span key={kw} style={{ fontSize: 11, color: 'var(--pm-link)', background: 'var(--pm-link-bg)', borderRadius: 4, padding: '1px 6px' }}>{kw}</span>
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
        <pre style={{ maxHeight: 480, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--pm-wash)', padding: 12, borderRadius: 8 }}>
          {viewContent}
        </pre>
        {viewRecord?.files && viewRecord.files.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Text strong style={{ fontSize: 12 }}>伴随脚本（只读）</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {viewRecord.files.map((f) => (
                <Button
                  key={f}
                  size="small"
                  type={scriptContent?.path === f ? 'primary' : 'text'}
                  style={{ justifyContent: 'flex-start', fontFamily: 'monospace', fontSize: 12 }}
                  onClick={() => viewName && openScript(viewName, f)}
                >
                  {f}
                </Button>
              ))}
            </div>
            {scriptContent && (
              <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, background: 'var(--pm-wash)', padding: 12, borderRadius: 8, marginTop: 8 }}>
                {scriptContent.content}
              </pre>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}

export default ExperiencePanel
