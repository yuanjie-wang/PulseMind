import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown } from 'antd'
import { PlusOutlined, FolderOutlined, FileOutlined, DownOutlined, CloseOutlined, UserOutlined, LockOutlined, SafetyOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { ContextRing } from './ContextRing'
import { Composer, useInputHistory, COMPOSER_MAX_WIDTH } from './Composer'
import type { ComposerHandle } from './Composer'
import { useComposerDraftStore } from '../../stores/composerDraftStore'
import type { LlmProfile } from '../../types/settings'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { DEFAULT_APPROVAL_MODE } from '../../../../shared/sandbox/policy'
import { modelLabel } from '../../../../shared/agent-protocol'

/** Approval levels, most restrictive first — the order the dropdown lists them
 *  in. The icons are chosen for distinct silhouettes, not for a family: antd's
 *  safety / safety-certificate pair is two shields that read as one glyph at
 *  14px, so the loosest level uses a bolt (goes straight through) instead. */
const APPROVAL_LEVELS: Array<{ mode: SandboxApprovalMode; icon: React.ReactNode }> = [
  { mode: 'always-ask', icon: <LockOutlined style={{ fontSize: 14 }} /> },
  { mode: 'outside-ask', icon: <SafetyOutlined style={{ fontSize: 14 }} /> },
  { mode: 'auto', icon: <ThunderboltOutlined style={{ fontSize: 14 }} /> },
]

/** 全部允许 (the 'auto' level) drops the approval ladder entirely: tool calls
 *  run unannounced, which is the one setting here that cannot be undone after
 *  the fact. So its icon and its wording are tinted amber — the same value the
 *  extension panel copies into `--pm-warn` and the same role the 待批准 tint
 *  plays in the transcript: this is the state to notice, not a neutral choice.
 *  Exported because the panel's stylesheet names it in a comment (it cannot
 *  import a TS value) — keep both in step. */
export const UNRESTRICTED_COLOR = '#d46b08'

/** The 授权 button's colour: only the unrestricted level is tinted; the rest keep
 *  the muted grey every other text button in the footer uses (which also beats
 *  antd's hover colour, so hovering does not brighten it). The dropdown tints its
 *  own 全部允许 item the same way and leaves the other items on antd's menu colour
 *  — a footer control's grey is not a menu's. */
function approvalButtonColor(mode: SandboxApprovalMode): string {
  return mode === 'auto' ? UNRESTRICTED_COLOR : '#666'
}

export function InputArea({
  isRequesting,
  isStreaming,
  isAwaitingApproval,
  isAwaitingInput,
  hasMessages,
  onSendMessage,
  onCancel,
  profiles,
  activeProfileId,
  onSelectProfile,
  contextUsed,
  contextLength,
  layout,
  placeholder,
  autoFocus,
  boundExpertId,
  onUnbindExpert,
  approvalMode,
  onChangeApprovalMode,
  features,
}: {
  isRequesting: boolean
  isStreaming: boolean
  isAwaitingApproval: boolean
  isAwaitingInput: boolean
  hasMessages: boolean
  onSendMessage: (content: string) => void
  onCancel: () => void
  profiles?: LlmProfile[]
  activeProfileId?: string
  onSelectProfile?: (profileId: string) => void
  contextUsed?: number
  contextLength?: number
  /** Composer layout: 'floating' (default) pins it to the bottom of the view;
   *  'inline' lays it out in place (welcome view's flex column). */
  layout?: 'floating' | 'inline'
  /** Overrides the status-derived placeholder (reuse sites whose input is not
   *  a chat turn, e.g. the expert editor's form filler). */
  placeholder?: string
  /** Focus the composer on mount. Defaults to the chat rule (only while the
   *  conversation is empty); pass false when the view has a form to work in. */
  autoFocus?: boolean
  /** Expert bound to the active conversation (@-summon); shows the chip. */
  boundExpertId?: string
  /** Clear the bound expert (chip ×). */
  onUnbindExpert?: () => void
  /** How tool calls are approved for this conversation — the effective mode,
   *  i.e. the project's policy when the conversation belongs to one. */
  approvalMode?: SandboxApprovalMode
  /** Pick a different level. */
  onChangeApprovalMode?: (mode: SandboxApprovalMode) => void
  /** Feature chrome subset for reuse outside the main chat (e.g. the routine
   *  run workspace). Omit for the full chat; a partial object exposes only the
   *  listed features. */
  features?: {
    attachments?: boolean
    modelPicker?: boolean
    experts?: boolean
    authorization?: boolean
  }
}): React.ReactElement {
  // Everything on when the prop is absent (the chat); a reuse site lists only
  // what it exposes.
  const showAttachments = features?.attachments ?? features === undefined
  const showModelPicker = features?.modelPicker ?? features === undefined
  const showExperts = features?.experts ?? features === undefined
  const showAuthorization = (features?.authorization ?? features === undefined) && onChangeApprovalMode !== undefined
  /** The composer-draft store is a chat/welcome mechanism (starter prompts);
   *  reuse sites must not consume those drafts. */
  const acceptsComposerDrafts = features === undefined
  const [inputValue, setInputValue] = useState('')
  /** The composer's textarea, so the @ button can put the caret back in it. */
  const composerRef = useRef<ComposerHandle>(null)

  // ── Expert config pack state ──
  // Enabled experts power both the @-selector and the bound-expert chip.
  // Loaded once per mount; the list only changes in the capability center.
  const [experts, setExperts] = useState<ExpertProfile[]>([])
  useEffect(() => {
    window.electronAPI.expertList?.()
      .then(setExperts)
      .catch(() => {})
  }, [])
  const summonableExperts = useMemo(
    () => experts.filter((e) => e.enabled ?? true),
    [experts]
  )
  const boundExpert = experts.find((e) => e.id === boundExpertId)

  // ── @-mention popup ──
  // Active while the caret-text ends with an @token (@ at word start). Selecting
  // an expert rewrites the token; sending the raw text also works — the
  // controller parses `@<name>` on submit, so the popup is pure assistance.
  const [mentionNavIdx, setMentionNavIdx] = useState(0)
  const atIdx = inputValue.lastIndexOf('@')
  const mentionActive = showExperts && atIdx >= 0 && (atIdx === 0 || /\s/.test(inputValue[atIdx - 1]))
  const mentionQuery = mentionActive ? inputValue.slice(atIdx + 1) : ''
  const mentionMatches = useMemo(() => {
    if (!mentionActive) return []
    const q = mentionQuery.trim().toLowerCase()
    const list = q
      ? summonableExperts.filter((e) => e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q))
      : summonableExperts
    return list.slice(0, 8)
  }, [mentionActive, mentionQuery, summonableExperts])

  const handleInputChange = (v: string): void => {
    setInputValue(v)
    setMentionNavIdx(0)
  }

  const selectMention = (expert: ExpertProfile): void => {
    setInputValue(`${inputValue.slice(0, atIdx)}@${expert.name} `)
  }

  /** The @ button: write an @-token into the input so the summon popup opens. A
   *  separator space comes along when the text would otherwise run the @ into a
   *  word — the popup only arms on an @ that starts one. */
  const insertMention = (): void => {
    setInputValue((prev) => (prev === '' || /\s$/.test(prev) ? `${prev}@` : `${prev} @`))
    setMentionNavIdx(0)
    // The click parked focus on the button; the popup reads typed keys and arrows
    // from the textarea, so hand it back.
    composerRef.current?.focus()
  }

  // Welcome starters drop their text here through the one-shot draft store:
  // subscribe (event-style, not render-driven) so a click lands in the input
  // whenever it happens, then the draft is consumed.
  useEffect(() => {
    if (!acceptsComposerDrafts) return
    return useComposerDraftStore.subscribe((s) => {
      if (s.draft !== null) {
        setInputValue(s.draft)
        useComposerDraftStore.getState().clearDraft()
      }
    })
  }, [acceptsComposerDrafts])
  const { t } = useTranslation()

  const history = useInputHistory()

  const isInputDisabled = isAwaitingApproval || isAwaitingInput

  const activeProfile = profiles?.find((p) => p.id === activeProfileId)
  // Through the shared helper (the extension panel's 模型下拉 uses it too): one
  // function decides how a profile is labelled, so the two surfaces cannot
  // drift. The placeholder is for "no profile at all", not for "a profile with
  // an empty name" — the helper falls back to provider:model for that.
  const activeModelLabel = activeProfile ? modelLabel(activeProfile) : t('chatView.selectModel')

  // 授权 button: the conversation's level drives the icon, the label and the
  // tooltip; the label repeats in the dropdown next to the same icon. An absent
  // level is the shared default (按需确认), resolved the way the engine resolves
  // it — never a hardcoded 'auto', or a fresh conversation would read as
  // unrestricted while its calls are actually held.
  const approvalLabel = approvalMode ?? DEFAULT_APPROVAL_MODE
  const approvalHint = t('chatView.approval.tooltip', { level: t(`chatView.approval.${approvalLabel}`) })

  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])

  const getFileName = (path: string) => path.replace(/^.*[\\/]/, '')

  const handlePickFile = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFiles((prev) => [...prev, ...result.filePaths])
    }
  }

  const handlePickFolder = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFolders((prev) => [...prev, ...result.filePaths])
    }
  }

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const removeFolder = (index: number) => {
    setSelectedFolders((prev) => prev.filter((_, i) => i !== index))
  }

  const modelItems =
    profiles?.map((p) => ({
      key: p.id,
      label: modelLabel(p),
      onClick: () => onSelectProfile?.(p.id),
    })) ?? []

  const hasAttachments = selectedFiles.length + selectedFolders.length > 0

  const handleComposerKeyDown = (e: React.KeyboardEvent<Element>): void => {
    // @-popup owns the navigation keys while it's open; the input-history hook
    // must not eat ArrowUp/Down then.
    if (mentionActive && mentionMatches.length > 0 && ['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) {
      e.preventDefault()
      if (e.key === 'Escape') return
      if (e.key === 'ArrowUp') setMentionNavIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
      else setMentionNavIdx((i) => (i + 1) % mentionMatches.length)
      return
    }
    history.onKeyDown(e, inputValue, setInputValue)
  }

  /** Compose the outgoing message: attachment refs first, then the typed text. */
  const buildMessage = (text: string): string => {
    const parts = [
      ...selectedFiles.map((p) => `[file:${p}]`),
      ...selectedFolders.map((p) => `[folder:${p}]`),
    ]
    return parts.length > 0 ? parts.join('\n') + (text ? '\n' + text : '') : text
  }

  const submit = (raw: string): void => {
    const text = raw.trim()
    if (!text && !hasAttachments) return
    const outgoing = buildMessage(text)
    history.push(outgoing)
    onSendMessage(outgoing)
    setInputValue('')
    setSelectedFiles([])
    setSelectedFolders([])
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* @-mention selector: floats above the composer at full composer width
          while the input ends in an @token. Sending the raw text works too
          (controller parses it). */}
      {mentionActive && mentionMatches.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            right: 0,
            // Mirror the visible .ant-sender box (COMPOSER_MAX_WIDTH, centered):
            // the Composer wrapper is wider, so left/right alone would let the
            // selector outgrow the input box it belongs to.
            maxWidth: COMPOSER_MAX_WIDTH,
            margin: '0 auto',
            zIndex: 100,
            maxHeight: 264,
            overflow: 'auto',
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 10,
            boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
            padding: 4,
          }}
        >
          <div style={{ fontSize: 11, color: '#999', padding: '4px 8px 2px' }}>{t('chatView.expert.summonTitle')}</div>
          {mentionMatches.map((expert, i) => (
            <div
              key={expert.id}
              onClick={() => selectMention(expert)}
              onMouseEnter={() => setMentionNavIdx(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                background: i === mentionNavIdx ? 'rgba(0,0,0,0.05)' : 'transparent',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expert.name}</div>
                {expert.description && (
                  <div style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expert.description}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <Composer
        ref={composerRef}
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={submit}
        onCancel={onCancel}
        isRequesting={isRequesting}
        disabled={isInputDisabled}
        loading={isRequesting && !isInputDisabled}
        layout={layout}
        autoFocus={autoFocus ?? !hasMessages}
        placeholder={
          placeholder ??
          (isAwaitingApproval
            ? t('chatView.sender.approving')
            : isAwaitingInput
              ? t('chatView.sender.awaitingInput')
              : isStreaming
                ? t('chatView.sender.streaming')
                : t('chatView.sender.default'))
        }
        header={
          boundExpert || hasAttachments ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, padding: '5px 0 0 5px' }}>
              {/* Bound-expert chip: the conversation's summoned expert config pack. */}
              {boundExpert && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: '#f0f0f0',
                    border: '1px solid rgba(0,0,0,0.06)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                    maxWidth: 220,
                  }}
                  title={boundExpert.description || boundExpert.name}
                >
                  <span style={{ fontSize: 13, lineHeight: 1 }}>
                    <UserOutlined style={{ fontSize: 11, color: '#666' }} />
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{boundExpert.name}</span>
                  <span
                    onClick={onUnbindExpert}
                    style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                    title={t('chatView.expert.unbind')}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              )}
              {selectedFolders.map((fp, i) => (
                <span
                  key={`f-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    background: '#e8e8e8',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FolderOutlined style={{ fontSize: 12, color: '#666' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFolder(i)}
                    style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              ))}
              {selectedFiles.map((fp, i) => (
                <span
                  key={`fi-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    background: '#e8e8e8',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FileOutlined style={{ fontSize: 12, color: '#666' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFile(i)}
                    style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              ))}
            </div>
          ) : undefined
        }
        footerLeft={
          <>
            {showAttachments && (
              <>
                <Button
                  size="small"
                  type="text"
                  icon={<PlusOutlined style={{ fontSize: 14 }} />}
                  onClick={handlePickFile}
                  style={{ fontSize: 12, color: '#666' }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<FolderOutlined style={{ fontSize: 14 }} />}
                  onClick={handlePickFolder}
                  style={{ fontSize: 12, color: '#666' }}
                />
              </>
            )}
            {showExperts && (
              <Button
                size="small"
                type="text"
                icon={<span style={{ fontSize: 14, fontWeight: 600 }}>@</span>}
                onClick={insertMention}
                title={t('chatView.expert.summonTitle')}
                style={{ fontSize: 12, color: '#666' }}
              />
            )}
            {showAuthorization && (
              <Dropdown
                trigger={['click']}
                // selectable + selectedKeys is what marks the active level; the
                // level itself is the item key.
                menu={{
                  items: APPROVAL_LEVELS.map(({ mode, icon }) => ({
                    key: mode,
                    icon,
                    label: t(`chatView.approval.${mode}`),
                    // Tinted on the item, so icon and label inherit one colour in
                    // the open list — 全部允许 is recognisable before it is picked,
                    // not only once it is in force. The other two keep antd's menu
                    // colour: the tint marks one level, it is not a menu theme.
                    style: mode === 'auto' ? { color: UNRESTRICTED_COLOR } : undefined,
                  })),
                  selectable: true,
                  selectedKeys: [approvalLabel],
                  onClick: ({ key }) => onChangeApprovalMode?.(key as SandboxApprovalMode),
                }}
              >
                <Button
                  size="small"
                  type="text"
                  icon={APPROVAL_LEVELS.find((l) => l.mode === approvalLabel)?.icon}
                  title={approvalHint}
                  aria-label={approvalHint}
                  style={{ fontSize: 12, color: approvalButtonColor(approvalLabel) }}
                >
                  {t(`chatView.approval.${approvalLabel}`)}
                  <DownOutlined style={{ fontSize: 10, color: '#bbb', marginLeft: 4 }} />
                </Button>
              </Dropdown>
            )}
          </>
        }
        trailing={
          <>
            {/* Right cluster order: context ring, model picker, send button. */}
            {hasMessages && contextLength != null && contextLength > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}>
                <ContextRing used={contextUsed ?? 0} total={contextLength} diameter={16} />
              </span>
            )}
            {showModelPicker && (
              <Dropdown menu={{ items: modelItems }} trigger={['click']}>
                <Button
                  size="small"
                  type="text"
                  icon={<DownOutlined />}
                  iconPlacement="end"
                  style={{ fontSize: 12, color: '#666' }}
                >
                  {activeModelLabel}
                </Button>
              </Dropdown>
            )}
          </>
        }
        onKeyDown={handleComposerKeyDown}
      />

    </div>
  )
}
