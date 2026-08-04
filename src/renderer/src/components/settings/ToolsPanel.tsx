import React, { useState } from 'react'
import {
  Collapse,
  Switch,
  Tag,
  Typography
} from 'antd'
import {
  CodeOutlined,
  FileOutlined,
  ToolOutlined,
  GlobalOutlined,
  QuestionCircleOutlined,
  DatabaseOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { ToolState } from '../../tools/types'

const { Text, Paragraph } = Typography

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  system: <CodeOutlined />,
  file: <FileOutlined />,
  tool: <ToolOutlined />,
  browser: <GlobalOutlined />,
  interaction: <QuestionCircleOutlined />,
  memory: <DatabaseOutlined />,
  knowledge: <DatabaseOutlined />
}

const CATEGORY_ORDER = ['file', 'system', 'browser', 'interaction', 'memory', 'knowledge']

interface ToolsPanelProps {
  tools: ToolState[]
  onToggleTool: (name: string) => void
}

function ToolsPanel({
  tools,
  onToggleTool
}: ToolsPanelProps): React.ReactElement {
  const { t } = useTranslation()

  const CATEGORY_LABELS: Record<string, string> = {
    file: t('tools.categories.file'),
    system: t('tools.categories.system'),
    browser: t('tools.categories.browser'),
    interaction: t('tools.categories.interaction'),
    memory: t('tools.categories.memory'),
    knowledge: t('tools.categories.knowledge'),
  }

  if (tools.length === 0) {
    return (
      <Text type="secondary">{t('tools.noTools')}</Text>
    )
  }

  // Group tools by category
  const grouped = new Map<string, ToolState[]>()
  for (const tool of tools) {
    const cat = tool.definition.category
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(tool)
  }

  // Sort: known categories in order, unknown categories appended
  const knownKeys = CATEGORY_ORDER.filter((c) => grouped.has(c))
  const unknownKeys = Array.from(grouped.keys()).filter(
    (c) => !CATEGORY_ORDER.includes(c)
  )
  const sortedKeys = [...knownKeys, ...unknownKeys]

  // Build collapse items
  const collapseItems = sortedKeys.map((category) => {
    const catTools = grouped.get(category)!
    const enabledCount = catTools.filter((t) => t.enabled).length
    const totalCount = catTools.length

    return {
      key: category,
      label: (
        <span>
          {CATEGORY_ICONS[category] || <ToolOutlined />}
          <Text style={{ marginLeft: 8 }}>
            {CATEGORY_LABELS[category] || category}
          </Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            ({enabledCount}/{totalCount})
          </Text>
        </span>
      ),
      children: catTools.map((tool) => (
        <ToolCard
          key={tool.definition.name}
          tool={tool}
          onToggle={onToggleTool}
        />
      ))
    }
  })

  return (
    <Collapse
      ghost
      defaultActiveKey={sortedKeys}
      items={collapseItems}
      style={{ background: 'transparent' }}
    />
  )
}

// --- Tool Card ---

interface ToolCardProps {
  tool: ToolState
  onToggle: (name: string) => void
}

function ToolCard({ tool, onToggle }: ToolCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { definition, enabled } = tool
  const { t } = useTranslation()

  return (
    <div
      style={{
        padding: '12px',
        borderBottom: '1px solid #f0f0f0',
        backgroundColor: '#F8F8F8'
      }}
    >
      {/* Header row: icon + name + badges + switch */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: 'pointer'
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0
          }}
        >
          {CATEGORY_ICONS[definition.category] || <ToolOutlined />}
          <Text strong style={{ fontSize: 14, color: enabled ? undefined : '#bbb' }} ellipsis>
            {definition.name}
          </Text>
          {definition.builtIn && (
            <Tag color='default' style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
              {t('common.builtIn')}
            </Tag>
          )}
        </div>

        <Switch
          size='small'
          checked={enabled}
          onClick={(checked, e) => {
            e.stopPropagation()
            onToggle(definition.name)
          }}
        />
      </div>

      {/* Description */}
      <Paragraph
        style={{
          fontSize: 12,
          margin: '4px 0 0 0',
          lineHeight: '1.4',
          color: '#888'
        }}
        ellipsis={!expanded ? { rows: 2 } : false}
      >
        {definition.description}
      </Paragraph>

      {/* Expanded: instructions */}
      {expanded && definition.instructions && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: '#fafafa',
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            lineHeight: '1.5'
          }}
        >
          {definition.instructions}
        </div>
      )}
    </div>
  )
}

export default ToolsPanel
