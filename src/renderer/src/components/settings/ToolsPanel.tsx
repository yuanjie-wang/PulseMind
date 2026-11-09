// ── Built-in tools panel ──
// The fourth capability-center tab. Composes the same CapabilityCard shell as
// 专家 / 技能 / 连接器 so the grid rhythm, hover, head/divider and action order
// cannot drift — the previous Collapse-list shape was the one skeleton the
// center's unification pass (P1) missed. Category section headers survive, since
// dozens of tools across 9 categories are more navigable grouped than as one
// flat grid. (The extension-only page_* family is not a category here — it is
// not registered in the desktop registry at all, so there is nothing to manage.)

import React, { useState } from 'react'
import { Tag, Typography } from 'antd'
import {
  CodeOutlined,
  FileOutlined,
  FileWordOutlined,
  ToolOutlined,
  GlobalOutlined,
  DatabaseOutlined,
  BranchesOutlined,
  PartitionOutlined,
  ReadOutlined,
  TrophyOutlined,
  DashboardOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { ToolState } from '../../tools/types'
import CapabilityCard, {
  CAPABILITY_GRID,
  CapabilitySwitch
} from '../common/CapabilityCard'

const { Text, Paragraph } = Typography

// 分类（2026-11-08 重划：office 从 file 拆出、system 拆壳为 shell/plan/skills，
// session 收编 interaction+context——见 builtin-gate.ts 与分类裁定）。
const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  file: <FileOutlined />,
  shell: <CodeOutlined />,
  git: <BranchesOutlined />,
  office: <FileWordOutlined />,
  memory: <DatabaseOutlined />,
  web: <GlobalOutlined />,
  browser: <GlobalOutlined />,
  plan: <PartitionOutlined />,
  skills: <ToolOutlined />,
  session: <DashboardOutlined />,
  knowledge: <ReadOutlined />,
  experience: <TrophyOutlined />
}

const CATEGORY_ORDER = ['file', 'shell', 'office', 'memory', 'web', 'browser', 'plan', 'skills', 'session', 'knowledge', 'experience', 'git']

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
    shell: t('tools.categories.shell'),
    git: t('tools.categories.git'),
    office: t('tools.categories.office'),
    memory: t('tools.categories.memory'),
    web: t('tools.categories.web'),
    browser: t('tools.categories.browser'),
    plan: t('tools.categories.plan'),
    skills: t('tools.categories.skills'),
    session: t('tools.categories.session'),
    knowledge: t('tools.categories.knowledge'),
    experience: t('tools.categories.experience')
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

  return (
    <div style={{ background: 'transparent' }}>
      {sortedKeys.map((category) => {
        const catTools = grouped.get(category)!
        const enabledCount = catTools.filter((tl) => tl.enabled).length
        return (
          <section key={category} style={{ marginBottom: 20 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
                padding: '0 2px'
              }}
            >
              {CATEGORY_ICONS[category] || <ToolOutlined />}
              <Text strong style={{ fontSize: 13 }}>
                {CATEGORY_LABELS[category] || category}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {enabledCount}/{catTools.length}
              </Text>
            </div>
            <div style={CAPABILITY_GRID}>
              {catTools.map((tool) => (
                <BuiltInToolCard
                  key={tool.definition.name}
                  tool={tool}
                  onToggle={onToggleTool}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// --- Tool Card ---

interface ToolCardProps {
  tool: ToolState
  onToggle: (name: string) => void
}

function BuiltInToolCard({ tool, onToggle }: ToolCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()
  const { definition, enabled } = tool

  return (
    <CapabilityCard
      icon={CATEGORY_ICONS[definition.category] || <ToolOutlined />}
      name={definition.name}
      badge={
        definition.availability === 'gated' ? (
          <Tag color="gold" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', flexShrink: 0 }}>
            {t('tools.status.awaitActivation')}
          </Tag>
        ) : (
          <Tag color="green" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', flexShrink: 0 }}>
            {t('tools.status.activated')}
          </Tag>
        )
      }
      onClick={() => setExpanded((e) => !e)}
      actions={
        <CapabilitySwitch checked={enabled} onToggle={() => onToggle(definition.name)} />
      }
    >
      <Paragraph
        style={{
          fontSize: 12,
          margin: 0,
          lineHeight: '1.4',
          color: 'var(--pm-text-quiet)'
        }}
        ellipsis={!expanded ? { rows: 2, expandable: false } : false}
      >
        {definition.description}
      </Paragraph>

      {expanded && definition.instructions && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: 'var(--pm-wash)',
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
    </CapabilityCard>
  )
}

export default ToolsPanel
