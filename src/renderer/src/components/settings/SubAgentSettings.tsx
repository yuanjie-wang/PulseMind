import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Button, Card, Tag, Typography, Input, Form, Select, Drawer, Modal, InputNumber, Spin, Switch, Collapse } from 'antd'
import {
  UserOutlined,
  EditOutlined,
  DeleteOutlined,
  ToolOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  LoadingOutlined,
  BookOutlined,
} from '@ant-design/icons'
import type { SubAgentProfile } from '../../../../shared/types/subagent'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'
import { useTranslation } from '../../i18n/useTranslation'

const { Text, Paragraph } = Typography

interface SubAgentSettingsProps {
  tools?: ToolState[]
  skills?: SkillState[]
}

/** Header actions the capability center renders next to its pill tabs. */
export interface SubAgentSettingsHandle {
  openAddModal: () => void
  resetToDefaults: () => void
}

type McpServerOption = { id: string; name: string }

/** Tools that are always enabled for sub-agents and cannot be deselected. */
const MANDATORY_TOOLS = new Set(['read', 'search', 'find', 'pick_skill', 'pick_tool'])

/** Icon presets for the expert card (emoji — zero assets, renders everywhere). */
const ICON_PRESETS = ['✍️', '🔍', '🌐', '📊', '🧭', '🧪', '💼', '🎓', '⚙️', '🤖', '📝', '🎨']

interface KnowledgeOption {
  id: string
  title: string
  filePath: string
}

const SubAgentSettings = React.forwardRef<SubAgentSettingsHandle, SubAgentSettingsProps>(
  function SubAgentSettings({ tools, skills }, ref) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<SubAgentProfile[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([])
  const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeOption[]>([])
  const [mainProfiles, setMainProfiles] = useState<Array<{ id: string; name: string; provider?: string; model: string }>>([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<SubAgentProfile | null>(null)
  const formSnapshot = useRef<Record<string, any>>({})
  const [form] = Form.useForm()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.subagentList()
      setProfiles(list)

      // Fetch main LLM profiles for the profile selector
      try {
        const settings = await window.electronAPI.getSettings()
        setMainProfiles(settings.profiles.map(p => ({
          id: p.id,
          name: p.name,
          provider: p.provider,
          model: p.model,
        })))
      } catch {
        // non-critical
      }

      // Fetch MCP servers for the selector
      try {
        const servers = await window.electronAPI.mcpListServers()
        setMcpServers(servers.map((s) => ({ id: s.id, name: s.name })))
      } catch {
        // MCP list is non-critical
      }

      // Knowledge files for the expert binding selector
      try {
        const files = await window.electronAPI.knowledgeListFiles()
        setKnowledgeFiles(files.map((f) => ({ id: f.id, title: f.title || f.filePath, filePath: f.filePath })))
      } catch {
        // knowledge list is non-critical
      }
    } catch (err) {
      console.log('[SubAgentSettings] Failed to list profiles:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // ── Tool options ──
  const toolOptions = React.useMemo(() => {
    if (!tools) return []
    const excludeTools = new Set(['ask_user', 'spawn_agent', 'create_plan', 'advance_plan'])
    return tools
      .filter((t) => !excludeTools.has(t.definition.name))
      .map((t) => ({
        value: t.definition.name,
        label: t.definition.name,
        disabled: MANDATORY_TOOLS.has(t.definition.name),
      }))
  }, [tools])

  const handleToolsChange = (values: string[]) => {
    // Ensure mandatory tools are never removed
    const withMandatory = [...MANDATORY_TOOLS].filter(t => !values.includes(t))
    if (withMandatory.length > 0) {
      form.setFieldsValue({ allowedTools: [...values, ...withMandatory] })
    }
  }

  // ── Skill options ──
  const skillOptions = React.useMemo(() => {
    if (!skills) return []
    return skills.map((s) => ({
      value: s.definition.name,
      label: s.definition.name,
    }))
  }, [skills])

  // ── MCP options ──
  const mcpOptions = mcpServers.map((s) => ({
    value: s.id,
    label: s.name,
  }))

  const knowledgeOptions = knowledgeFiles.map((f) => ({
    value: f.id,
    label: f.title,
  }))

  // ── Actions ──

  const openAddModal = () => {
    setEditingProfile(null)
    form.resetFields()
    form.setFieldsValue({
      id: '',
      icon: undefined,
      allowedTools: [...MANDATORY_TOOLS],
      allowedMcpServers: [],
      allowedSkills: [],
      knowledgeFileIds: [],
      maxTokens: undefined,
      maxLoopIterations: undefined,
    })
    setFormOpen(true)
  }

  const openEditModal = (profile: SubAgentProfile) => {
    setEditingProfile(profile)
    const snapshot = {
      id: profile.id,
      name: profile.name,
      icon: profile.icon,
      description: profile.description,
      basePrompt: profile.basePrompt,
      methodology: profile.methodology,
      outputSpec: profile.outputSpec,
      constraints: profile.constraints,
      profileId: profile.profileId,
      allowedTools: profile.isBuiltIn ? [] : profile.allowedTools,
      allowedMcpServers: profile.allowedMcpServers,
      allowedSkills: profile.allowedSkills,
      knowledgeFileIds: profile.knowledgeFileIds || [],
      maxTokens: profile.maxTokens,
      maxLoopIterations: profile.maxLoopIterations,
    }
    formSnapshot.current = snapshot
    form.setFieldsValue(snapshot)
    setFormOpen(true)
  }

  const generateIdFromName = (name: string): string => {
    return name.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9一-鿿぀-ゟ゠-ヿ-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'custom-' + Date.now()
  }

  const handleToggleEnabled = async (profile: SubAgentProfile) => {
    const updatedProfile = { ...profile, enabled: !(profile.enabled ?? true) }
    const updated = await window.electronAPI.subagentUpdate(updatedProfile)
    setProfiles(updated)
  }

  const handleDelete = async (profile: SubAgentProfile) => {
    if (profile.isBuiltIn) return
    Modal.confirm({
      title: t('expertCenter.deleteConfirmTitle'),
      content: t('expertCenter.deleteConfirmContent', { name: profile.name }),
      onOk: async () => {
        const updated = await window.electronAPI.subagentDelete(profile.id)
        setProfiles(updated)
      },
    })
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const id = editingProfile ? editingProfile.id : values.id

      const isBuiltIn = editingProfile?.isBuiltIn ?? false
      const profile: SubAgentProfile = {
        id,
        name: values.name,
        icon: values.icon || undefined,
        description: values.description || undefined,
        basePrompt: values.basePrompt || '',
        methodology: values.methodology || undefined,
        outputSpec: values.outputSpec || undefined,
        constraints: values.constraints || undefined,
        knowledgeFileIds: values.knowledgeFileIds || [],
        profileId: values.profileId || undefined,
        allowedTools: isBuiltIn
          ? editingProfile!.allowedTools
          : (values.allowedTools || []),
        allowedMcpServers: values.allowedMcpServers || [],
        allowedSkills: values.allowedSkills || [],
        maxTokens: values.maxTokens || undefined,
        maxLoopIterations: values.maxLoopIterations || undefined,
        isBuiltIn,
      }

      const updated = editingProfile
        ? await window.electronAPI.subagentUpdate(profile)
        : await window.electronAPI.subagentCreate(profile)

      setProfiles(updated)
      setFormOpen(false)
    } catch {
      // validation failed
    }
  }

  const handleResetForm = () => {
    form.setFieldsValue(formSnapshot.current)
  }

  const handleReset = () => {
    Modal.confirm({
      title: t('expertCenter.resetConfirmTitle'),
      content: t('expertCenter.resetConfirmContent'),
      onOk: async () => {
        const updated = await window.electronAPI.subagentReset()
        setProfiles(updated)
      },
    })
  }

  const getMcpName = (id: string): string => {
    return mcpServers.find((s) => s.id === id)?.name || id
  }

  const getKnowledgeTitles = (ids: string[]): string => {
    return ids.map((id) => knowledgeFiles.find((f) => f.id === id)?.title || id).join('、')
  }

  // ── Render ──

  // Expose the former title-row actions to the capability center's pill row.
  React.useImperativeHandle(ref, () => ({ openAddModal, resetToDefaults: handleReset }))

  /** A titled form section — the drawer groups fields into four labeled blocks. */
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#999', margin: '14px 0 10px', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  )

  const content = (
    <>
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin indicator={<LoadingOutlined />} />
        </div>
      ) : profiles.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>
          <UserOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
          <Text type="secondary">{t('expertCenter.empty')}</Text>
          <div style={{ fontSize: 12, color: '#bbb', marginTop: 6 }}>{t('expertCenter.emptyHint')}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {profiles.map((profile) => (
            <Card
              key={profile.id}
              size="small"
              style={{ borderRadius: 10, background: '#fafafa' }}
              title={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0, width: 20, textAlign: 'center' }}>
                    {profile.icon || <UserOutlined style={{ color: '#666', fontSize: 14 }} />}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name}</span>
                  {profile.isBuiltIn && (
                    <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
                      {t('expertCenter.builtInTag')}
                    </Tag>
                  )}
                </span>
              }
              extra={
                <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                  <Switch
                    size="small"
                    checked={profile.enabled ?? true}
                    onClick={() => handleToggleEnabled(profile)}
                  />
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEditModal(profile)} />
                  {!profile.isBuiltIn && (
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(profile)} />
                  )}
                </span>
              }
            >
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{profile.id}</Text>

              {/* Curated one-liner; fall back to the persona snippet. */}
              {(profile.description || profile.basePrompt) && (
                <Paragraph
                  style={{ fontSize: 12, marginBottom: 8, color: '#888' }}
                  ellipsis={{ rows: 3, expandable: false }}
                >
                  {profile.description || profile.basePrompt}
                </Paragraph>
              )}

              {/* Tool tags */}
              {profile.allowedTools.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                  <ToolOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {profile.allowedTools.map((tool) => (
                      <Tag key={tool} style={{ fontSize: 11, margin: 0 }} color="geekblue">
                        {tool}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* MCP tags */}
              {profile.allowedMcpServers.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                  <ApiOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {profile.allowedMcpServers.map((mcp) => (
                      <Tag key={mcp} style={{ fontSize: 11, margin: 0 }} color="green">
                        {getMcpName(mcp)}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* Skill tags */}
              {profile.allowedSkills.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                  <ThunderboltOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {profile.allowedSkills.map((skill) => (
                      <Tag key={skill} style={{ fontSize: 11, margin: 0 }} color="purple">
                        {skill}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* Bound knowledge tag (count + tooltip with titles) */}
              {!!profile.knowledgeFileIds?.length && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <BookOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                  <Tag style={{ fontSize: 11, margin: 0 }} color="orange" title={getKnowledgeTitles(profile.knowledgeFileIds)}>
                    {t('knowledgePanel.title')} × {profile.knowledgeFileIds.length}
                  </Tag>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit Drawer */}
      <Drawer
        title={editingProfile ? t('expertCenter.editTitle') : t('expertCenter.createTitle')}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        styles={{ wrapper: { width: 480 } }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              {editingProfile?.isBuiltIn && (
                <Button onClick={handleResetForm}>
                  {t('common.dismiss')}
                </Button>
              )}
            </div>
            <div>
              <Button onClick={() => setFormOpen(false)} style={{ marginRight: 8 }}>
                {t('common.cancel')}
              </Button>
              <Button type="primary" onClick={handleSubmit} style={{ background: '#000', borderColor: '#000' }}>
                {editingProfile ? t('common.save') : t('common.confirm')}
              </Button>
            </div>
          </div>
        }
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Section title={t('expertCenter.sectionBasic')}>
            <div style={{ display: 'flex', gap: 12 }}>
              <Form.Item name="name" label={t('expertCenter.name')} rules={[{ required: true, message: t('expertCenter.nameRequired') }]} style={{ flex: 1 }}>
                <Input placeholder={t('expertCenter.namePlaceholder')} disabled={editingProfile?.isBuiltIn} onChange={(e) => {
                  if (!editingProfile) {
                    const currentId = form.getFieldValue('id')
                    const autoId = generateIdFromName(e.target.value)
                    if (!currentId || currentId === generateIdFromName(formSnapshot.current.name || '') || currentId.startsWith('custom-')) {
                      form.setFieldsValue({ id: autoId })
                    }
                  }
                }} />
              </Form.Item>
              <Form.Item name="icon" label={t('expertCenter.icon')}>
                <Select
                  allowClear
                  placeholder="—"
                  style={{ width: 80 }}
                  options={ICON_PRESETS.map((e) => ({ value: e, label: e }))}
                  optionRender={(o) => <span style={{ fontSize: 16 }}>{o.label}</span>}
                />
              </Form.Item>
            </div>
            {!editingProfile && (
              <Form.Item name="id" label={t('expertCenter.id')} rules={[{ required: true, message: t('expertCenter.idRequired') }]}>
                <Input placeholder={t('expertCenter.idPlaceholder')} />
              </Form.Item>
            )}
            <Form.Item name="description" label={t('expertCenter.description')}>
              <Input placeholder={t('expertCenter.descriptionPlaceholder')} maxLength={80} />
            </Form.Item>
          </Section>

          <Section title={t('expertCenter.sectionPersona')}>
            <Form.Item name="basePrompt" label={t('expertCenter.persona')}>
              <Input.TextArea
                rows={4}
                placeholder={t('expertCenter.personaPlaceholder')}
              />
            </Form.Item>
            <Collapse ghost size="small" items={[
              {
                key: 'methodology',
                label: <span style={{ fontSize: 12, color: '#666' }}>{t('expertCenter.methodology')}</span>,
                children: (
                  <Form.Item name="methodology" style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={4} placeholder={t('expertCenter.methodologyPlaceholder')} />
                  </Form.Item>
                ),
              },
              {
                key: 'outputSpec',
                label: <span style={{ fontSize: 12, color: '#666' }}>{t('expertCenter.outputSpec')}</span>,
                children: (
                  <Form.Item name="outputSpec" style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={4} placeholder={t('expertCenter.outputSpecPlaceholder')} />
                  </Form.Item>
                ),
              },
              {
                key: 'constraints',
                label: <span style={{ fontSize: 12, color: '#666' }}>{t('expertCenter.constraints')}</span>,
                children: (
                  <Form.Item name="constraints" style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={3} placeholder={t('expertCenter.constraintsPlaceholder')} />
                  </Form.Item>
                ),
              },
            ]} />
          </Section>

          <Section title={t('expertCenter.sectionBindings')}>
            <Form.Item
              label={t('expertCenter.allowedTools')}
              help={t('expertCenter.mandatoryToolsHint')}
            >
              {editingProfile?.isBuiltIn ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
                  {editingProfile.allowedTools.map(name => (
                    <Tag key={name} color="blue" style={{ fontSize: 11, margin: 0 }}>{name}</Tag>
                  ))}
                </div>
              ) : (
                <Form.Item name="allowedTools" noStyle>
                  <Select
                    mode="multiple"
                    placeholder={t('expertCenter.allowedToolsPlaceholder')}
                    options={toolOptions}
                    maxTagCount={8}
                    showSearch
                    onChange={handleToolsChange}
                  />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item name="allowedMcpServers" label={t('expertCenter.allowedMcpServers')}>
              <Select
                mode="multiple"
                placeholder={t('expertCenter.allowedMcpPlaceholder')}
                options={mcpOptions}
                maxTagCount={6}
              />
            </Form.Item>
            <Form.Item name="allowedSkills" label={t('expertCenter.allowedSkills')}>
              <Select
                mode="multiple"
                placeholder={t('expertCenter.allowedSkillsPlaceholder')}
                options={skillOptions}
                maxTagCount={6}
              />
            </Form.Item>
            <Form.Item name="knowledgeFileIds" label={t('expertCenter.knowledgeFiles')}>
              <Select
                mode="multiple"
                placeholder={knowledgeFiles.length > 0 ? t('expertCenter.knowledgePlaceholder') : t('expertCenter.knowledgeEmpty')}
                options={knowledgeOptions}
                maxTagCount={6}
                optionFilterProp="label"
              />
            </Form.Item>
          </Section>

          <Section title={t('expertCenter.sectionRuntime')}>
            <Form.Item name="profileId" label={t('expertCenter.profileId')}>
              <Select
                allowClear
                placeholder={t('expertCenter.profileIdPlaceholder')}
                options={mainProfiles.map(p => ({
                  value: p.id,
                  label: `${p.name} (${p.provider || '?'} / ${p.model})`,
                }))}
              />
            </Form.Item>
            <div style={{ display: 'flex', gap: 16 }}>
              <Form.Item name="maxTokens" label={t('expertCenter.maxTokens')}>
                <InputNumber min={256} max={128000} step={1024} placeholder="—" style={{ width: 160 }} />
              </Form.Item>
              <Form.Item name="maxLoopIterations" label={t('expertCenter.maxLoopIterations')}>
                <InputNumber min={1} max={100} placeholder="20" style={{ width: 160 }} />
              </Form.Item>
            </div>
          </Section>
        </Form>
      </Drawer>
    </>
  )

  return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
  }
)

export default SubAgentSettings
