import React, { useEffect, useState, useCallback } from 'react'
import { Button, Card, Typography, Spin, Switch, Modal, message } from 'antd'
import {
  UserOutlined,
  EditOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
  BookOutlined,
  ThunderboltOutlined,
  ApiOutlined,
} from '@ant-design/icons'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { KnowledgeOption } from '../../agent/one-shot-agent'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import ExpertEditor from './expert/ExpertEditor'
import type { ExpertRefOption } from './expert/ExpertFormFields'

const { Text, Paragraph } = Typography

/** Header actions the capability center renders next to its pill tabs. */
export interface ExpertSettingsHandle {
  openAddModal: () => void
  resetToDefaults: () => void
}

/** The pane is self-contained today — kept so the capability center's
 *  forwardRef call sites stay typed. */
export interface ExpertSettingsProps {
  children?: never
}

/**
 * 专家 tab of the capability center. Two modes share the pane:
 *  - browse: the expert card grid (enable / edit / delete)
 *  - edit: the three-column editor (expert list · form · conversational filler)
 * Experts describe identity + bound knowledge only — capability follows the
 * global setting, so no tool/connector/skill selectors live here anymore.
 */
const ExpertSettings = React.forwardRef<ExpertSettingsHandle, ExpertSettingsProps>(function ExpertSettings(
  _props,
  ref
): React.ReactElement {
  const { t } = useTranslation()
  const { settings } = useSettings()
  const [profiles, setProfiles] = useState<ExpertProfile[]>([])
  const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeOption[]>([])
  const [skillOptions, setSkillOptions] = useState<ExpertRefOption[]>([])
  const [connectorOptions, setConnectorOptions] = useState<ExpertRefOption[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [mode, setMode] = useState<'browse' | 'edit'>('browse')
  // Bumped whenever the user picks a different expert: remounting the editor
  // per session resets the dirty flag and the assistant transcript without any
  // reset effects. Saving keeps the session, so the thread survives a save.
  const [session, setSession] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.expertList()
      setProfiles(list)

      // Bound-knowledge selector options (non-critical when empty).
      try {
        const files = await window.electronAPI.knowledgeListFiles()
        setKnowledgeFiles(files.map((f) => ({ id: f.id, title: f.title || f.filePath })))
      } catch {
        // knowledge list is non-critical
      }

      // 引用关系候选：技能按 name 引用，连接器按 MCP 服务 id 引用。
      try {
        const skills = await window.electronAPI.listImportedSkills()
        setSkillOptions(skills.map((s) => ({ value: s.name, label: s.name })))
      } catch {
        // skill catalog is non-critical
      }
      try {
        const servers = await window.electronAPI.mcpListServers()
        setConnectorOptions(servers.map((s) => ({ value: s.id, label: s.name })))
      } catch {
        // connector catalog is non-critical
      }
    } catch (err) {
      console.log('[ExpertSettings] Failed to list experts:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const enterEdit = (id: string | null): void => {
    setEditingId(id)
    setSession((n) => n + 1)
    setMode('edit')
  }

  const selectExpert = (id: string | null): void => {
    setEditingId(id)
    setSession((n) => n + 1)
  }

  const openAddModal = (): void => enterEdit(null)

  const handleToggleEnabled = async (profile: ExpertProfile): Promise<void> => {
    const updated = await window.electronAPI.expertUpdate({ ...profile, enabled: !(profile.enabled ?? true) })
    setProfiles(updated)
  }

  const handleDelete = (profile: ExpertProfile): void => {
    Modal.confirm({
      title: t('expertCenter.deleteConfirmTitle'),
      content: t('expertCenter.deleteConfirmContent', { name: profile.name }),
      onOk: async () => {
        const updated = await window.electronAPI.expertDelete(profile.id)
        setProfiles(updated)
        if (editingId === profile.id) {
          setEditingId(null)
          setMode('browse')
        }
      },
    })
  }

  const handleReset = (): void => {
    Modal.confirm({
      title: t('expertCenter.resetConfirmTitle'),
      content: t('expertCenter.resetConfirmContent'),
      onOk: async () => {
        try {
          setProfiles(await window.electronAPI.expertReset())
        } catch (err) {
          // 重置失败必须可见（如 DB 约束冲突），不能静默吞掉让用户以为成功。
          console.error('[ExpertSettings] reset failed:', err)
          message.error(t('expertCenter.resetFailed'))
        }
      },
    })
  }

  // Expose the title-row actions to the capability center's pill row.
  React.useImperativeHandle(ref, () => ({ openAddModal, resetToDefaults: handleReset }))

  if (mode === 'edit') {
    return (
      <ExpertEditor
        key={session}
        profiles={profiles}
        editingId={editingId}
        onSelect={selectExpert}
        onExit={() => setMode('browse')}
        onSaved={(updated, id) => {
          setProfiles(updated)
          setEditingId(id)
        }}
        onDeleted={(updated) => {
          setProfiles(updated)
          setEditingId(null)
          setMode('browse')
        }}
        knowledgeFiles={knowledgeFiles}
        skillOptions={skillOptions}
        connectorOptions={connectorOptions}
        locale={settings.locale || 'zh'}
      />
    )
  }

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <Spin indicator={<LoadingOutlined />} />
      </div>
    )
  }

  if (profiles.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>
        <UserOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
        <Text type="secondary">{t('expertCenter.empty')}</Text>
        <div style={{ fontSize: 12, color: '#bbb', marginTop: 6 }}>{t('expertCenter.emptyHint')}</div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          style={{ marginTop: 16, background: '#000', borderColor: '#000' }}
          onClick={() => enterEdit(null)}
        >
          {t('expertCenter.newExpert')}
        </Button>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {profiles.map((profile) => (
          <Card
            key={profile.id}
            size="small"
            style={{ borderRadius: 10, background: '#fafafa' }}
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <UserOutlined style={{ color: '#666', fontSize: 14, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name}</span>
              </span>
            }
            extra={
              <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                <Switch
                  size="small"
                  checked={profile.enabled ?? true}
                  onClick={() => handleToggleEnabled(profile)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  title={t('expertCenter.editTitle')}
                  onClick={() => enterEdit(profile.id)}
                />
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(profile)} />
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

            {/* Bound knowledge (count + tooltip with the titles) */}
            {!!profile.knowledgeFileIds?.length && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <BookOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                <span
                  style={{ fontSize: 11, color: '#888' }}
                  title={profile.knowledgeFileIds
                    .map((id) => knowledgeFiles.find((f) => f.id === id)?.title || id)
                    .join('、')}
                >
                  {t('knowledgePanel.title')} × {profile.knowledgeFileIds.length}
                </span>
              </div>
            )}

            {/* 引用关系（指令提示，不是权限）——只显示数量，明细在编辑表单里。 */}
            {!!profile.skillNames?.length && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
                <ThunderboltOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                <span style={{ fontSize: 11, color: '#888' }} title={profile.skillNames.join('、')}>
                  {t('expertCenter.skillNames')} × {profile.skillNames.length}
                </span>
              </div>
            )}
            {!!profile.mcpServerIds?.length && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
                <ApiOutlined style={{ color: '#999', marginTop: 3, fontSize: 12 }} />
                <span
                  style={{ fontSize: 11, color: '#888' }}
                  title={profile.mcpServerIds.map((id) => connectorOptions.find((c) => c.value === id)?.label || id).join('、')}
                >
                  {t('expertCenter.mcpServerIds')} × {profile.mcpServerIds.length}
                </span>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
})

export default ExpertSettings
