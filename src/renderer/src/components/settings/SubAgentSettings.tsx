import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Button, Tag, Typography, Input, Form, Select, Drawer, Modal, InputNumber, Spin, Tooltip, Switch } from 'antd'
import {
  UserOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ToolOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import type { SubAgentProfile } from '../../../../shared/types/subagent'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'

const { Text, Title, Paragraph } = Typography

interface SubAgentSettingsProps {
  inline?: boolean
  open?: boolean
  onClose?: () => void
  tools?: ToolState[]
  skills?: SkillState[]
}

type McpServerOption = { id: string; name: string }

/** Tools that are always enabled for sub-agents and cannot be deselected. */
const MANDATORY_TOOLS = new Set(['read', 'search', 'find', 'pick_skill', 'pick_tool'])

export default function SubAgentSettings({ inline = true, open, onClose, tools, skills }: SubAgentSettingsProps) {
  const [profiles, setProfiles] = useState<SubAgentProfile[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([])
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

  // ── Actions ──

  const openAddModal = () => {
    setEditingProfile(null)
    form.resetFields()
    form.setFieldsValue({
      id: '',
      allowedTools: [...MANDATORY_TOOLS],
      allowedMcpServers: [],
      allowedSkills: [],
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
      basePrompt: profile.basePrompt,
      profileId: profile.profileId,
      allowedTools: profile.isBuiltIn ? [] : profile.allowedTools,
      allowedMcpServers: profile.allowedMcpServers,
      allowedSkills: profile.allowedSkills,
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
      title: '确认删除',
      content: `确定要删除子代理配置 "${profile.name}" 吗？`,
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
        basePrompt: values.basePrompt || '',
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
      title: '重置默认',
      content: '将恢复默认的两个子代理配置（通用子代理、画布子代理），自定义配置将被保留，确定继续？',
      onOk: async () => {
        const updated = await window.electronAPI.subagentReset()
        setProfiles(updated)
      },
    })
  }

  const getMcpName = (id: string): string => {
    return mcpServers.find((s) => s.id === id)?.name || id
  }

  // ── Render ──

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Title level={5} style={{ margin: 0 }}>子代理管理</Title>
        <div style={{ display: 'flex', gap: 6 }}>
          <Tooltip title="新建子代理">
            <Button size="small" icon={<PlusOutlined />} onClick={openAddModal} />
          </Tooltip>
          <Tooltip title="重置默认配置">
            <Button size="small" icon={<UndoOutlined />} onClick={handleReset} />
          </Tooltip>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin indicator={<LoadingOutlined />} />
        </div>
      ) : profiles.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>
          <UserOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
          <Text type="secondary">没有子代理配置</Text>
        </div>
      ) : (
        profiles.map((profile) => (
          <div
            key={profile.id}
            style={{
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              padding: 16,
              marginBottom: 12,
              background: '#fafafa',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserOutlined style={{ fontSize: 18, color: '#666' }} />
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text strong>{profile.name}</Text>
                    {profile.isBuiltIn && (
                      <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                        内置
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 11 }}>{profile.id}</Text>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {!profile.isBuiltIn && (
                  <Switch
                    size="small"
                    checked={profile.enabled ?? true}
                    onClick={() => handleToggleEnabled(profile)}
                  />
                )}
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(profile)} />
                {!profile.isBuiltIn && (
                  <Button size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(profile)} />
                )}
              </div>
            </div>

            {/* Description - max 3 lines */}
            {profile.basePrompt && (
              <Paragraph
                style={{ fontSize: 12, marginBottom: 8, color: '#888' }}
                ellipsis={{ rows: 3, expandable: false }}
              >
                {profile.basePrompt}
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
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
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

            {/* No capabilities - show nothing */}
          </div>
        ))
      )}

      {/* Add / Edit Drawer */}
      <Drawer
        title={editingProfile ? '编辑子代理' : '新建子代理'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        styles={{ wrapper: { width: 480 } }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              {editingProfile?.isBuiltIn && (
                <Button onClick={handleResetForm}>
                  重置
                </Button>
              )}
            </div>
            <div>
              <Button onClick={() => setFormOpen(false)} style={{ marginRight: 8 }}>
                取消
              </Button>
              <Button type="primary" onClick={handleSubmit} style={{ background: '#000', borderColor: '#000' }}>
                {editingProfile ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        }
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入子代理名称' }]}>
            <Input placeholder="例如: 代码审查代理" disabled={editingProfile?.isBuiltIn} onChange={(e) => {
              if (!editingProfile) {
                const currentId = form.getFieldValue('id')
                const autoId = generateIdFromName(e.target.value)
                if (!currentId || currentId === generateIdFromName(formSnapshot.current.name || '') || currentId.startsWith('custom-')) {
                  form.setFieldsValue({ id: autoId })
                }
              }
            }} />
          </Form.Item>
          {!editingProfile && (
            <Form.Item name="id" label="ID" rules={[{ required: true, message: '请输入子代理 ID' }]}>
              <Input placeholder="例如: code-review-agent" />
            </Form.Item>
          )}
          <Form.Item name="basePrompt" label="基础提示词">
            <Input.TextArea
              rows={6}
              placeholder="描述子代理的职责和行为方式，将注入到子代理的 System Prompt 中"
            />
          </Form.Item>
          <div style={{ borderTop: '1px solid #f0f0f0', margin: '16px 0' }} />
          <Form.Item name="profileId" label="继承 LLM 配置">
            <Select
              allowClear
              placeholder="不选则使用当前激活的配置"
              options={mainProfiles.map(p => ({
                value: p.id,
                label: `${p.name} (${p.provider || '?'} / ${p.model})`,
              }))}
            />
          </Form.Item>
          <div style={{ borderTop: '1px solid #f0f0f0', margin: '16px 0' }} />
          <Form.Item label={
            <span><ToolOutlined style={{ marginRight: 4 }} />可用工具</span>
          }>
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
                  placeholder="选择子代理可使用的工具"
                  options={toolOptions}
                  maxTagCount={8}
                  showSearch
                  onChange={handleToolsChange}
                />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item name="allowedMcpServers" label={
            <span><ApiOutlined style={{ marginRight: 4 }} />可用 MCP 服务</span>
          }>
            <Select
              mode="multiple"
              placeholder="选择子代理可访问的 MCP 服务（不选表示无限制）"
              options={mcpOptions}
              maxTagCount={6}
            />
          </Form.Item>
          <Form.Item name="allowedSkills" label={
            <span><ThunderboltOutlined style={{ marginRight: 4 }} />可用技能</span>
          }>
            <Select
              mode="multiple"
              placeholder="选择子代理可使用的技能（不选表示无限制）"
              options={skillOptions}
              maxTagCount={6}
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="maxTokens" label="最大输出 Token">
              <InputNumber min={256} max={128000} step={1024} placeholder="默认" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="maxLoopIterations" label="最大循环次数">
              <InputNumber min={1} max={100} placeholder="默认 20" style={{ width: 160 }} />
            </Form.Item>
          </div>
        </Form>
      </Drawer>
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
  }

  return (
    <Drawer title="子代理管理" open={open} onClose={onClose} size={400}>
      {content}
    </Drawer>
  )
}
