import React, { useEffect, useState } from 'react'
import { Tag, Typography, Alert } from 'antd'

const { Text } = Typography
import {
  BugOutlined,
  CodeOutlined,
  ReadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { SkillState } from '../../skills/types'
import CapabilityCard, {
  CAPABILITY_GRID,
  CapabilityDeleteButton,
  CapabilityEmpty,
  CapabilitySwitch
} from '../common/CapabilityCard'
import SkillBrowser, { experienceKey } from './SkillBrowser'
import MemoryPagesBrowser from '../knowledge/MemoryPagesPanel'

const { Paragraph } = Typography

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  engineering: <CodeOutlined />,
  debugging: <BugOutlined />,
  education: <ReadOutlined />
}

interface SkillsPanelProps {
  skills: SkillState[]
  onToggleSkill: (name: string) => void
  onDeleteSkill?: (name: string) => void
}

function SkillsPanel({
  skills,
  onToggleSkill,
  onDeleteSkill,
}: SkillsPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const LS_KEY = 'pulsemind_dismissed_skills_tip'
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(LS_KEY) === 'true')
  // Non-null = a card was clicked and the three-column browser replaced the grid.
  // The key is a skill name, or experienceKey(pageId) — 经验也是技能（E1），同一浏览器。
  const [viewing, setViewing] = useState<string | null>(null)
  // 技能卡的「使用 N 次 · 安装于 …」（2026-10-27）：pick_skill 记账在 skill_uses，这里
  // 按名取；从浏览器返回栅格时重取（期间可能发生了拉取）。
  const [uses, setUses] = useState<SkillUseMap>({})
  // 经验分区标题右侧的总数——由 MemoryPagesBrowser 回报未过滤总量（与内置/已安装同款）
  const [expCount, setExpCount] = useState<number | null>(null)
  useEffect(() => {
    if (viewing !== null) return
    let cancelled = false
    window.electronAPI
      .listSkillUses()
      .then((m) => { if (!cancelled) setUses(m) })
      .catch(() => { /* 计数拿不到就不显示，不影响卡片 */ })
    return () => { cancelled = true }
  }, [viewing])
  const dismissTip = () => {
    localStorage.setItem(LS_KEY, 'true')
    setTipDismissed(true)
  }
  const visibleSkills = skills.filter(s => !s.definition.name.startsWith('ex.'))

  if (viewing !== null) {
    return (
      <div style={{ height: '100%' }}>
        <SkillBrowser
          skills={visibleSkills}
          activeKey={viewing}
          onSelect={setViewing}
          onBack={() => setViewing(null)}
        />
      </div>
    )
  }

  // 三分区（PLAN-capability-followups E1）：内置（厂商装）/ 已安装（用户装）/ 经验（自己学）。
  // 经验存储在 memory_pages——展示归位技能中心，卡片与技能同壳同开关（2026-10-26/27 裁定），
  // 写路径与治理仍在记忆层（写路径决定归属，展示面跟内容语义走）。
  const builtInSkills = visibleSkills.filter((s2) => s2.definition.builtIn)
  const importedSkills = visibleSkills.filter((s2) => !s2.definition.builtIn)
  const skillCard = (skill: SkillState): React.ReactElement => (
    <SkillCard
      key={skill.definition.name}
      skill={skill}
      use={uses[skill.definition.name]}
      onToggle={onToggleSkill}
      onDeleteSkill={onDeleteSkill}
      onOpen={setViewing}
    />
  )
  // count = null：总量还没回报（经验分区首帧）——不画 0 再跳成真值
  const sectionTitle = (label: string, count: number | null): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '18px 0 10px' }}>
      <Text strong style={{ fontSize: 14 }}>{label}</Text>
      {count !== null && <Text type="secondary" style={{ fontSize: 12 }}>{count}</Text>}
    </div>
  )

  return (
    <div style={{ background: 'transparent' }}>
      {visibleSkills.length === 0 && <CapabilityEmpty title={t('skills.noSkills')} />}

      {sectionTitle(t('skillsSection.builtIn'), builtInSkills.length)}
      <div style={CAPABILITY_GRID}>
        {builtInSkills.map(skillCard)}
      </div>

      {sectionTitle(t('skillsSection.imported'), importedSkills.length)}
      <div style={CAPABILITY_GRID}>
        {importedSkills.map(skillCard)}
      </div>

      {sectionTitle(t('skillsSection.experience'), expCount)}
      <ExperienceSection onOpen={(pageId) => setViewing(experienceKey(pageId))} onCount={setExpCount} />

      {/* ── Internet search tip ── */}
      {!tipDismissed && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={dismissTip}
          title={t('skills.internetSearchTip')}
          style={{ fontSize: 12, marginTop: 16 }}
        />
      )}
    </div>
  )
}

// --- Skill Card ---

type SkillUseInfo = { useCount: number; lastUsedAt: string | null; installedAt: string | null }
type SkillUseMap = Record<string, SkillUseInfo>

interface SkillCardProps {
  skill: SkillState
  use?: SkillUseInfo
  onToggle: (name: string) => void
  onDeleteSkill?: (name: string) => void
  onOpen: (name: string) => void
}

function SkillCard({ skill, use, onToggle, onDeleteSkill, onOpen }: SkillCardProps): React.ReactElement {
  const { t } = useTranslation()
  const { definition, enabled } = skill
  // 安装时间：内置技能是随应用来的，没有「安装」这回事——用户裁定显示 `--`；
  // 已安装技能取目录创建时间（frontmatter createdAt 优先，它更接近「做出来的时间」）。
  const installedDate = definition.builtIn
    ? '--'
    : (definition.createdAt ?? use?.installedAt ?? '').slice(0, 10) || '--'

  return (
    <CapabilityCard
      icon={CATEGORY_ICONS[definition.category] ?? <ThunderboltOutlined />}
      name={definition.name}
      badge={
        definition.builtIn ? (
          <Tag color="default" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
            {t('common.builtIn')}
          </Tag>
        ) : undefined
      }
      onClick={() => onOpen(definition.name)}
      actions={
        <>
          {/* 内置技能恒启用（2026-11-04 裁定「内置恒不可关」，review_20261105
              中4）：引擎侧 applyPreferences 把内置从 disabled 集剥除，开关
              点了只是「假关」——内存态翻回、DB 残留陈旧条目、重载静默复开。
              开关置 disabled + tooltip 说清原因，引擎侧 SkillManager.toggle
              同步拒绝翻转（防未来的第二调用方）。 */}
          <CapabilitySwitch
            checked={enabled}
            disabled={definition.builtIn}
            onLabel={t('skills.builtInAlwaysOn')}
            offLabel={t('skills.builtInAlwaysOn')}
            onToggle={() => onToggle(definition.name)}
          />
          {!definition.builtIn && onDeleteSkill && (
            <CapabilityDeleteButton onClick={() => onDeleteSkill(definition.name)} />
          )}
        </>
      }
    >
      {/* Description — clicking the card opens the file browser instead */}
      <Paragraph
        style={{
          fontSize: 12,
          margin: 0,
          lineHeight: '1.4',
          color: 'var(--pm-text-quiet)'
        }}
        ellipsis={{ rows: 4 }}
      >
        {definition.description}
      </Paragraph>
      {/* 元信息行（2026-10-27）：使用次数 · 安装时间——经验卡同形（提取于） */}
      <div data-card-meta style={{ marginTop: 8, fontSize: 11, color: 'var(--pm-text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {t('skills.useCount', { count: use?.useCount ?? 0 })} · {t('skills.installedAt', { date: installedDate })}
      </div>
    </CapabilityCard>
  )
}

export default SkillsPanel

// --- Experience section（E1）---

function ExperienceSection({ onOpen, onCount }: { onOpen: (pageId: string) => void; onCount: (n: number) => void }): React.ReactElement {
  // MemoryPagesBrowser 在 experience 形态下自带 CAPABILITY_GRID（与上面两个技能
  // 网格同栅格），这里不再外包一层——否则 paddingBottom 叠加。点击经验卡进入与
  // 技能一致的三栏浏览器（不再是详情 Modal）；固化/删除留在卡片头部动作区。
  return <MemoryPagesBrowser fixedType="experience" deletable onOpenPage={(page) => onOpen(page.id)} onCount={onCount} />
}
