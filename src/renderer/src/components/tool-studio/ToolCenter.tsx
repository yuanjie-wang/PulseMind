// ── Tool center (工具中心) ──
// PLAN-0.4.0 M5.4: the gallery — my tools + preset templates in one place,
// with the prominent 创造工具 entry into the studio. Templates are clonable
// starting points (D9/D12).

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Card, Empty, Tabs, Tag, Tooltip } from 'antd'
import { PlusOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { UserTool } from '../../../../shared/types/user-tool'
import { ToolRunner } from './ToolRunner'
import { ToolStudio } from './ToolStudio'

const CAPABILITY_LABELS: Record<string, string> = {
  'net:http': '网络',
  'fs:read': '读文件',
  'fs:write': '写文件',
  clipboard: '剪贴板',
  notify: '通知',
  'open-external': '外链',
}

type Pane = { kind: 'gallery' } | { kind: 'studio'; tool: UserTool | null } | { kind: 'runner'; tool: UserTool }

export default function ToolCenter(): React.ReactElement {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const [pane, setPane] = useState<Pane>({ kind: 'gallery' })
  const [tools, setTools] = useState<UserTool[]>([])
  const [templates, setTemplates] = useState<Array<UserTool & { isTemplate: true }>>([])

  const reload = useCallback(async () => {
    try {
      setTools(await window.electronAPI.toolList())
      setTemplates(await window.electronAPI.toolListTemplates())
    } catch (err) {
      console.warn('[ToolCenter] load failed:', err)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const removeTool = (tool: UserTool): void => {
    modal.confirm({
      title: `删除「${tool.name}」？`,
      content: '工具文件会一并删除，不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.toolDelete(tool.id)
        void reload()
      },
    })
  }

  const exportTool = async (tool: UserTool): Promise<void> => {
    const html = await window.electronAPI.toolReadHtml(tool.id)
    if (!html) {
      message.warning('该工具还没有内容')
      return
    }
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tool.name}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  const cloneTemplate = async (template: UserTool): Promise<void> => {
    const tool = await window.electronAPI.toolCloneTemplate(template.id, `${template.name}（副本）`)
    await reload()
    message.success('已复制到我的工具，可以继续改造')
    setPane({ kind: 'studio', tool })
  }

  // ── Non-gallery panes ──
  if (pane.kind === 'studio') {
    return (
      <ToolStudio
        tool={pane.tool}
        onBack={() => { setPane({ kind: 'gallery' }); void reload() }}
        onToolCreated={() => { /* gallery refreshes on back */ }}
      />
    )
  }
  if (pane.kind === 'runner') {
    return (
      <ToolRunner
        tool={pane.tool}
        onBack={() => setPane({ kind: 'gallery' })}
        onEdit={(tool) => setPane({ kind: 'studio', tool })}
      />
    )
  }

  // ── Gallery ──
  const toolCard = (tool: UserTool, isTemplate: boolean): React.ReactElement => (
    <Card
      key={tool.id}
      hoverable
      style={{ borderRadius: 10, overflow: 'hidden' }}
      onClick={() => { isTemplate ? void cloneTemplate(tool) : setPane({ kind: 'runner', tool }) }}
      title={<span style={{ fontSize: 14 }}>{tool.name}</span>}
      extra={
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 2 }}>
          {!isTemplate && (
            <>
              <Tooltip title="继续修改">
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setPane({ kind: 'studio', tool })} />
              </Tooltip>
              <Tooltip title="导出 HTML">
                <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => void exportTool(tool)} />
              </Tooltip>
              <Tooltip title="删除">
                <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeTool(tool)} />
              </Tooltip>
            </>
          )}
          {isTemplate && (
            <Tooltip title="复制到我的工具">
              <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void cloneTemplate(tool)} />
            </Tooltip>
          )}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 64 }}>
        <div style={{ fontSize: 12, color: '#888', minHeight: 32 }}>
          {tool.description || '（无描述）'}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(tool.capabilities ?? []).map((cap) => <Tag key={cap} style={{ fontSize: 10 }}>{CAPABILITY_LABELS[cap] ?? cap}</Tag>)}
          {isTemplate && <Tag style={{ fontSize: 10 }}>模板</Tag>}
        </div>
      </div>
    </Card>
  )

  const grid = (children: React.ReactNode): React.ReactElement => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, padding: '4px 0 24px' }}>
      {children}
    </div>
  )

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>{t('viewTitle.tools')}</span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setPane({ kind: 'studio', tool: null })}>
          创造工具
        </Button>
      </div>

      <Tabs
        defaultActiveKey="mine"
        items={[
          {
            key: 'mine',
            label: `我的工具（${tools.length}）`,
            children: tools.length === 0
              ? <Empty description="还没有工具——点右上角「创造工具」，或从下面的模板复制一个" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 48 }} />
              : grid(tools.map((tool) => toolCard(tool, false))),
          },
          {
            key: 'templates',
            label: `预置模板（${templates.length}）`,
            children: templates.length === 0
              ? <Empty description="模板目录为空" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 48 }} />
              : grid(templates.map((tpl) => toolCard(tpl, true))),
          },
        ]}
      />
    </div>
  )
}
