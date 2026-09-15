import React, { useCallback, useEffect, useState } from 'react'
import { Button, Form, Modal } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, UserOutlined, SaveOutlined, RobotOutlined, FormOutlined } from '@ant-design/icons'
import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { ExpertFormDraft } from '../../../agent/one-shot-agent'
import { pickDraftFields } from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'
import { EDITOR_CHAT_CARD, EDITOR_COLUMN_HEADER as COLUMN_HEADER, EDITOR_LIST_WIDTH, EDITOR_SURFACE } from '../../layout/editor-layout'
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
}

export interface ExpertEditorProps {
  profiles: ExpertProfile[]
  /** Profile being edited; null = an unsaved new expert. */
  editingId: string | null
  onSelect: (id: string | null) => void
  /** Leave the editor and go back to the card grid. */
  onExit: () => void
  onSaved: (profiles: ExpertProfile[], id: string) => void
  /** A profile was deleted: the fresh list, plus which id went away. */
  onDeleted: (profiles: ExpertProfile[], deletedId: string) => void
  /** 可用技能候选（名称即标识）。 */
  skillOptions: ExpertRefOption[]
  /** 可用连接器候选（MCP 服务 id）。 */
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

  /** Deleting is destructive and irreversible — always ask first. */
  const deleteExpert = (profile: ExpertProfile): void => {
    Modal.confirm({
      title: t('expertCenter.deleteConfirmTitle'),
      content: t('expertCenter.deleteConfirmContent', { name: profile.name }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const updated = await window.electronAPI.expertDelete(profile.id)
        if (profile.id === editingId) setDirty(false)
        onDeleted(updated, profile.id)
      },
    })
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 12 }}>
      {/* ── Left: expert list (also the switcher) ── */}
      <div style={{ width: EDITOR_LIST_WIDTH, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ ...COLUMN_HEADER, paddingTop: 12 }}>
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
        <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {/* No 新建专家 row here: the header's + is the single "add" affordance,
              and a row with a name-like label reads as an expert. */}
          {profiles.map((p) => (
            <ListRow
              key={p.id}
              active={p.id === editingId}
              label={p.name}
              muted={p.enabled === false}
              onClick={() => handleSelect(p.id)}
              onDelete={() => deleteExpert(p)}
              deleteTitle={t('expertCenter.deleteRow', { name: p.name })}
            />
          ))}
        </div>
      </div>

      {/* ── Form + chat on one gray surface ── */}
      {/* The chat is an accessory of the form, not a third peer column: the two
          share one rounded gray surface, and the chat sits inside it as a white
          rounded card. */}
      <div style={EDITOR_SURFACE}>
        {/* ── Middle: the form ── */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={COLUMN_HEADER}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <FormOutlined />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {editing ? t('expertCenter.editTitle') : t('expertCenter.createTitle')}
              </span>
              {dirty && <span style={{ color: '#faad14', fontWeight: 400, flexShrink: 0 }}>· {t('expertCenter.unsaved')}</span>}
            </span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              {/* Deleting lives on the list row only — the form column is for
                  editing, and a trash next to 保存 invites misclicks. */}
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
          {/* paddingRight keeps the (auto-hiding) gutter clear of the form edge. */}
          <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
            <ExpertFormFields
              form={form}
              isNew={!editing}
              skillOptions={skillOptions}
              connectorOptions={connectorOptions}
              onValuesChange={() => setDirty(true)}
            />
          </div>
        </div>

        {/* ── Right: conversational form filler, as a white card ── */}
        {/* Wider than a form column: the transcript is the chat's own message
            list, whose bubbles are capped at 70% of the row. Shrinks before the
            form column's min-width does when the window is narrow. */}
        <div style={EDITOR_CHAT_CARD}>
          <div style={COLUMN_HEADER}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RobotOutlined />
              {t('expertCenter.chatTitle')}
            </span>
          </div>
          <ExpertChatPanel getDraft={getDraft} onApplyDraft={applyDraft} locale={locale} />
        </div>
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

/** One row of the left column. The delete affordance only shows on hover or
 *  while the row is selected — a permanent trash icon on every row would read
 *  as noise, and its click must not also select the row. */
function ListRow({
  active,
  label,
  muted,
  onClick,
  onDelete,
  deleteTitle,
}: {
  active: boolean
  label: string
  muted?: boolean
  onClick: () => void
  onDelete?: () => void
  deleteTitle?: string
}): React.ReactElement {
  const { t } = useTranslation()
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
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {onDelete && (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          title={deleteTitle ?? t('common.delete')}
          style={{ opacity: hover || active ? 1 : 0, pointerEvents: hover || active ? 'auto' : 'none', flexShrink: 0 }}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        />
      )}
    </div>
  )
}
