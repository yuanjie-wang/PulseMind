import React, { useCallback, useEffect, useState } from 'react'
import { Button, Form, Modal } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, UserOutlined, SaveOutlined, RobotOutlined, FormOutlined } from '@ant-design/icons'
import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { ExpertFormDraft, KnowledgeOption } from '../../../agent/one-shot-agent'
import { pickDraftFields } from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'
import ExpertFormFields, { type ExpertRefOption } from './ExpertFormFields'
import ExpertChatPanel from './ExpertChatPanel'

/** Empty form seed for a brand-new expert. */
const BLANK_DRAFT: ExpertFormDraft = {
  name: '',
  description: '',
  basePrompt: '',
  methodology: '',
  outputSpec: '',
  constraints: '',
  knowledgeFileIds: [],
  skillNames: [],
  mcpServerIds: [],
}

const COLUMN_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#999',
  padding: '0 0 8px 2px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
}

export interface ExpertEditorProps {
  profiles: ExpertProfile[]
  /** Profile being edited; null = an unsaved new expert. */
  editingId: string | null
  onSelect: (id: string | null) => void
  /** Leave the editor and go back to the card grid. */
  onExit: () => void
  onSaved: (profiles: ExpertProfile[], id: string) => void
  onDeleted: (profiles: ExpertProfile[]) => void
  knowledgeFiles: KnowledgeOption[]
  /** 常用技能候选（名称即标识）。 */
  skillOptions: ExpertRefOption[]
  /** 常用连接器候选（MCP 服务 id）。 */
  connectorOptions: ExpertRefOption[]
  locale: string
}

/**
 * Edit mode of the expert tab: expert list on the left, the identity form in
 * the middle, and the conversational filler on the right. Left column doubles
 * as the switcher — selecting another expert asks first when the form is dirty.
 */
export default function ExpertEditor({
  profiles,
  editingId,
  onSelect,
  onExit,
  onSaved,
  onDeleted,
  knowledgeFiles,
  skillOptions,
  connectorOptions,
  locale,
}: ExpertEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const editing = editingId ? profiles.find((p) => p.id === editingId) || null : null

  // Load the selected expert into the form on every switch. The dirty flag needs
  // no reset here: the parent remounts this editor per editing session.
  useEffect(() => {
    if (editing) {
      form.setFieldsValue({
        id: editing.id,
        name: editing.name,
        description: editing.description,
        basePrompt: editing.basePrompt,
        methodology: editing.methodology,
        outputSpec: editing.outputSpec,
        constraints: editing.constraints,
        knowledgeFileIds: editing.knowledgeFileIds || [],
        skillNames: editing.skillNames || [],
        mcpServerIds: editing.mcpServerIds || [],
      })
    } else {
      form.resetFields()
      form.setFieldsValue(BLANK_DRAFT)
    }
  }, [editing, editingId, form])

  const getDraft = useCallback((): ExpertFormDraft => pickDraftFields(form.getFieldsValue()), [form])

  /** Merge an assistant patch into the form — only the keys it proposed. */
  const applyDraft = useCallback(
    (draft: ExpertFormDraft) => {
      form.setFieldsValue(draft)
      setDirty(true)
    },
    [form],
  )

  /** Both leaving the editor and switching experts drop the form — ask first when it is dirty. */
  const confirmDiscard = (action: () => void): void => {
    if (!dirty) {
      action()
      return
    }
    Modal.confirm({
      title: t('expertCenter.discardConfirmTitle'),
      content: t('expertCenter.discardConfirmContent'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: action,
    })
  }

  const handleSelect = (id: string | null): void => {
    if (id === editingId) return
    confirmDiscard(() => onSelect(id))
  }

  const handleSave = async (): Promise<void> => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      // A new expert's id is derived from its name, so a second expert with the
      // same name would collide with the first — dedupe instead of failing.
      const id = editing ? editing.id : uniqueExpertId(values.id, profiles)
      const profile: ExpertProfile = {
        id,
        name: values.name,
        description: values.description || undefined,
        basePrompt: values.basePrompt || '',
        methodology: values.methodology || undefined,
        outputSpec: values.outputSpec || undefined,
        constraints: values.constraints || undefined,
        knowledgeFileIds: values.knowledgeFileIds || [],
        skillNames: values.skillNames || [],
        mcpServerIds: values.mcpServerIds || [],
        enabled: editing?.enabled ?? true,
      }
      const updated = editing ? await window.electronAPI.expertUpdate(profile) : await window.electronAPI.expertCreate(profile)
      setDirty(false)
      onSaved(updated, profile.id)
    } catch (err) {
      // Validation errors are shown inline by the form; anything else is real.
      if (err && typeof err === 'object' && 'errorFields' in err) return
      console.error('[ExpertEditor] save failed:', err)
      Modal.error({ title: t('expertCenter.saveFailed'), content: String(err) })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (): void => {
    if (!editing) return
    Modal.confirm({
      title: t('expertCenter.deleteConfirmTitle'),
      content: t('expertCenter.deleteConfirmContent', { name: editing.name }),
      onOk: async () => {
        const updated = await window.electronAPI.expertDelete(editing.id)
        setDirty(false)
        onDeleted(updated)
      },
    })
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* ── Left: expert list (also the switcher) ── */}
      <div style={{ width: 216, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, paddingRight: 12, borderRight: '1px solid #f0f0f0' }}>
        <div style={COLUMN_HEADER}>
          {/* Leaving the editor belongs with the list — it is the list column's
              own "back" affordance, not a form action. */}
          <Button
            size="small"
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => confirmDiscard(onExit)}
            style={{ marginLeft: -4 }}
          >
            {t('expertCenter.backToList')}
          </Button>
          <Button size="small" type="text" icon={<PlusOutlined />} title={t('expertCenter.newExpert')} onClick={() => handleSelect(null)} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* No 新建专家 row here: the header's + is the single "add" affordance,
              and a row with a name-like label reads as an expert. */}
          {profiles.map((p) => (
            <ListRow
              key={p.id}
              active={p.id === editingId}
              label={p.name}
              muted={p.enabled === false}
              onClick={() => handleSelect(p.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Middle: the form ── */}
      <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 16px' }}>
        <div style={COLUMN_HEADER}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <FormOutlined />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {editing ? t('expertCenter.editTitle') : t('expertCenter.createTitle')}
            </span>
            {dirty && <span style={{ color: '#faad14', fontWeight: 400, flexShrink: 0 }}>· {t('expertCenter.unsaved')}</span>}
          </span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            {editing && <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={handleDelete} />}
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void handleSave()}
              style={{ background: '#000', borderColor: '#000' }}
            >
              {t('common.save')}
            </Button>
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <ExpertFormFields
            form={form}
            isNew={!editing}
            knowledgeFiles={knowledgeFiles}
            skillOptions={skillOptions}
            connectorOptions={connectorOptions}
            onValuesChange={() => setDirty(true)}
          />
        </div>
      </div>

      {/* ── Right: conversational form filler ── */}
      {/* Wider than a form column: the transcript is the chat's own message
          list, whose bubbles are capped at 70% of the row. Shrinks before the
          form column's min-width does when the window is narrow. */}
      <div style={{ flex: '0 1 460px', minWidth: 300, display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid #f0f0f0', paddingLeft: 16 }}>
        <div style={COLUMN_HEADER}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RobotOutlined />
            {t('expertCenter.chatTitle')}
          </span>
        </div>
        <ExpertChatPanel getDraft={getDraft} onApplyDraft={applyDraft} knowledgeFiles={knowledgeFiles} locale={locale} />
      </div>
    </div>
  )
}

/** Keep a derived id from colliding with an existing expert's id. */
function uniqueExpertId(base: string, profiles: ExpertProfile[]): string {
  if (!profiles.some((p) => p.id === base)) return base
  let n = 2
  while (profiles.some((p) => p.id === `${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** One row of the left column. */
function ListRow({
  active,
  label,
  muted,
  onClick,
}: {
  active: boolean
  label: string
  muted?: boolean
  onClick: () => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        marginBottom: 2,
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 13,
        background: active ? 'rgba(0,0,0,0.06)' : hover ? 'rgba(0,0,0,0.03)' : 'transparent',
        color: muted ? '#bbb' : '#333',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span style={{ width: 16, textAlign: 'center', flexShrink: 0, color: muted ? '#ccc' : '#888' }}>
        <UserOutlined />
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}
