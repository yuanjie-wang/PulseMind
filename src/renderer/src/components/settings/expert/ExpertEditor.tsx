import React, { useCallback, useEffect, useState } from 'react'
import { Button, Form, Modal } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, UserOutlined, SaveOutlined, FormOutlined } from '@ant-design/icons'
import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { ExpertFormDraft } from './expert-assist'
import { EXPERT_ASSIST_SPEC, EXPERT_ASSIST_ALLOWED_TOOLS, EXPERT_ASSISTANT_PROFILE, captureExpertFormValues, nextDerivedExpertId, pickDraftFields } from './expert-assist'
import { AppliedPatchBar } from '../../form-assist/AppliedPatchBar'
import { FormAssistColumn } from '../../form-assist/FormAssistColumn'
import { buildFormAssistSystemPrompt, formAssistConversationId } from '../../form-assist/form-assist'
import { discardAssistConversation, promoteAssistDraftToEntity } from '../../form-assist/session-lifecycle'
import { useFormAssistSession } from '../../form-assist/useFormAssistSession'
import { useSettings } from '../../../hooks/SettingsContext'
import { useTranslation } from '../../../i18n/useTranslation'
import { notify } from '../../../utils/notify'
import { EDITOR_COLUMN_HEADER as COLUMN_HEADER, EDITOR_LIST_WIDTH, EDITOR_SURFACE } from '../../layout/editor-layout'
import ExpertFormFields, { type ExpertRefOption } from './ExpertFormFields'

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
  const { settings, switchProfile } = useSettings()
  const [form] = Form.useForm()
  // Last id derived from the name — shared with ExpertFormFields' typing path
  // so the「id follows the name」rule has one mark of "still derived" across
  // both writers (typing and assistant patches).
  const derivedIdRef = React.useRef('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  /** Undo frames for the assistant's auto-applied patches (user ruling
   *  2026-09-20): each apply captures ALL chat-fillable fields — empties
   *  included, see captureExpertFormValues — plus the dirty flag, so 撤销
   *  puts the form back exactly as it was. */
  const [undoStack, setUndoStack] = useState<Array<{ values: ExpertFormDraft; dirty: boolean }>>([])
  /** Which expert the assistant conversation is bound to; null = the create-
   *  flow's draft slot. The first save PROMOTES the draft thread into the new
   *  expert's slot and re-binds (用户裁定 2026-09-20：每个专家最多关联一个会
   *  话), so the just-had context follows the expert instead of stranding in
   *  the draft bucket. The parent's key={session} remount on a user switch
   *  re-initializes it. */
  const [boundId, setBoundId] = useState<string | null>(editingId)
  /** Bumped whenever the bound thread is discarded (新会话 / a fresh create
   *  entry): the session hook re-restores empty under the same convId. */
  const [sessionReset, setSessionReset] = useState(0)
  const editing = editingId ? profiles.find((p) => p.id === editingId) || null : null

  const assistConvId = formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, boundId)

  /** 丢弃一个槽位的线程并重置会话视图 — the shared core of 新会话 and every
   *  entry into the create flow (新建即新会话；每个专家最多关联一个会话，旧
   *  线程直接丢弃). Undo frames belong to the discarded thread and die too.
   *  The target defaults to the currently bound slot; entering create mode
   *  from the list column's + passes the DRAFT slot explicitly — it runs
   *  before the re-bind, when assistConvId still points at the old expert. */
  const discardBoundSession = useCallback((targetConvId?: string): void => {
    setUndoStack([])
    void discardAssistConversation(targetConvId ?? assistConvId).then(() => setSessionReset((n) => n + 1))
  }, [assistConvId])

  const assist = useFormAssistSession({
    convId: assistConvId,
    title: `[${t('expertCenter.chatTitle')}] ${editing?.name ?? ''}`.trim(),
    spec: EXPERT_ASSIST_SPEC,
    systemPrompt: buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, locale),
    // D15/D16: the internal expert pack (identity) + host-side tool pin (D17).
    allowedTools: EXPERT_ASSIST_ALLOWED_TOOLS,
    expertProfile: EXPERT_ASSISTANT_PROFILE,
    resetKey: sessionReset,
    // 自动填入 (user ruling 2026-09-20): every newly parsed patch lands in
    // the form the moment its reply lands; the undo bar binds to
    // assist.appliedPatch. Unstable identity is safe — the hook's fire-once
    // ledger makes its effect's re-runs no-ops, and this closure reads the
    // live form when a real patch fires.
    onPatch: (patch) => {
      setUndoStack((stack) => [...stack, { values: captureExpertFormValues(form.getFieldsValue()), dirty }])
      form.setFieldsValue(patch)
      // The id follows a patch's name exactly as it follows typing: the name
      // input's onChange never fires for setFieldsValue, so the derive rule
      // runs here too. Only while creating — an existing expert keeps its id
      // (the field is not even mounted), and nextDerivedExpertId still refuses
      // when the user hand-typed an id or the patch brought its own.
      if (!editing && patch.name) {
        const derived = nextDerivedExpertId(form.getFieldValue('id'), derivedIdRef.current, patch.name)
        if (derived !== null) {
          derivedIdRef.current = derived
          form.setFieldsValue({ id: derived })
        }
      }
      setDirty(true)
    },
  })

  // Load the selected expert into the form on every switch. The dirty flag needs
  // no reset here: the parent remounts this editor per editing session.
  useEffect(() => {
    // The derive mark is per form load: an existing expert's id is its own
    // (and never derives — the field is hidden), a fresh form starts over.
    derivedIdRef.current = editing ? editing.id : ''
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

  // 新建专家即新会话 (user ruling 2026-09-20): the draft slot keeps no history
  // across create flows — mounting straight into create mode (every 能力中心
  // 新建 entry remounts this editor) discards whatever thread the previous
  // create flow left there. Switching to create via the list column's + goes
  // through handleSelect below; both entries share discardBoundSession.
  const mountedCreateRef = React.useRef(editingId === null)
  useEffect(() => {
    if (!mountedCreateRef.current) return
    mountedCreateRef.current = false
    discardBoundSession()
    // Create-entry only — mount-time state, never a re-run on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Every ask carries the live form (annotation) so hand edits reach the
   *  model too — same contract as the routine editor's assistant. */
  const askAssistant = useCallback(
    (text: string) => assist.send(text, pickDraftFields(form.getFieldsValue())),
    [assist, form],
  )

  /** 撤销 the assistant's last auto-applied patch: restore the captured
   *  pre-apply values wholesale. Manual edits made AFTER the apply go back
   *  with it — one click answers 「把刚填的撤掉」, and redo lives in the
   *  transcript (the content is still there verbatim). */
  const undoAssistantPatch = (): void => {
    const frame = undoStack[undoStack.length - 1]
    if (!frame) return
    setUndoStack((stack) => stack.slice(0, -1))
    form.setFieldsValue(frame.values)
    setDirty(frame.dirty)
    assist.clearAppliedPatch()
    notify.success(t('formAssist.undone'))
  }

  const appliedBar = assist.appliedPatch ? (
    <AppliedPatchBar
      summary={`${t('formAssist.autoFilled')}${assist.appliedPatch.name ? `：「${assist.appliedPatch.name}」` : ''}`}
      onUndo={undoAssistantPatch}
    />
  ) : null

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
    confirmDiscard(() => {
      // Entering create mode from the list column's + is a fresh create flow:
      // the draft slot's previous thread is discarded, a new one starts. The
      // draft slot is named explicitly — the re-bind has not happened yet.
      if (id === null) discardBoundSession(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, null))
      setBoundId(id)
      onSelect(id)
    })
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
      if (!editing) {
        // 升格 (user ruling 2026-09-20): the thread the assistant is currently
        // bound to (the draft slot on this path) becomes this expert's own
        // conversation — re-persisted under the expert's slot, the old slot
        // discarded, then re-bind so the convId switch re-restores from the
        // new slot. The just-had context follows the expert, and the
        // one-conversation-per-expert invariant holds from birth. The prefix
        // (not `profile.id`) names the target: the *slot* is what keeps the row
        // an 'expert' conversation rather than a chat in 历史对话.
        await promoteAssistDraftToEntity(
          assist.messages,
          EXPERT_ASSIST_SPEC.conversationPrefix,
          assistConvId,
          profile.id,
          `[${t('expertCenter.chatTitle')}] ${profile.name}`.trim(),
        )
        setBoundId(profile.id)
      }
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
        // The assistant thread dies with its expert — dispose the live
        // main-side session first or a stale engine would hold the context.
        await discardAssistConversation(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, profile.id))
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
              >
                {t('common.save')}
              </Button>
            </span>
          </div>
          {/* paddingRight keeps the (auto-hiding) gutter clear of the form edge. */}
          <div className="auto-hide-scroll" style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
            {appliedBar && <div style={{ marginBottom: 14 }}>{appliedBar}</div>}
            <ExpertFormFields
              form={form}
              isNew={!editing}
              derivedIdRef={derivedIdRef}
              skillOptions={skillOptions}
              connectorOptions={connectorOptions}
              onValuesChange={() => setDirty(true)}
            />
          </div>
        </div>

        {/* ── Right: conversational form filler — the shared form-assist
            column (hosted session; the thread persists per expert and
            survives restarts). Wider than a form column: the transcript is
            the chat's own message list, whose bubbles are capped at 70% of
            the row. Shrinks before the form column's min-width does when the
            window is narrow. */}
        <FormAssistColumn
          session={assist}
          title={t('expertCenter.chatTitle')}
          placeholder={t('expertCenter.chatPlaceholder')}
          emptyIntro={t('expertCenter.chatIntro')}
          emptyExamples={[t('expertCenter.chatExample1'), t('expertCenter.chatExample2')]}
          profiles={settings.profiles}
          activeProfileId={settings.activeProfileId}
          onSelectProfile={(profileId) => void switchProfile(profileId)}
          onSendMessage={askAssistant}
          onNewSession={discardBoundSession}
        />
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
        background: active ? 'var(--pm-hover)' : hover ? 'var(--pm-hover-faint)' : 'transparent',
        color: muted ? 'var(--pm-text-faint)' : 'var(--pm-text-strong)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span style={{ width: 16, textAlign: 'center', flexShrink: 0, color: muted ? 'var(--pm-text-disabled)' : 'var(--pm-text-quiet)' }}>
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
