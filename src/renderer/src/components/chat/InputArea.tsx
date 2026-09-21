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
 *  the fact. So its icon and its wording are tinted amber — the same role the
 *  待批准 tint plays in the transcript: this is the state to notice, not a
 *  neutral choice. The value is the sheet's `--pm-warn`, which the extension
 *  panel mirrors by hand (it cannot import a TS value) — keep both in step. */
export const UNRESTRICTED_COLOR = 'var(--pm-warn)'

/** The 授权 button's colour: only the unrestricted level is tinted; the rest keep
 *  the muted grey every other text button in the footer uses (which also beats
 *  antd's hover colour, so hovering does not brighten it). The dropdown tints its
 *  own 全部允许 item the same way and leaves the other items on antd's menu colour
 *  — a footer control's grey is not a menu's. */
function approvalButtonColor(mode: SandboxApprovalMode): string {
  return mode === 'auto' ? UNRESTRICTED_COLOR : 'var(--pm-text-secondary)'
}

export function InputArea({
  isRequesting,
  isStreaming,
  isAwaitingApproval,
  isAwaitingInput,
  hasMessages,
  topSlot,
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
  focusToken,
  sendBlocked,
  sendAccentHue,
  boundExpertId,
  onUnbindExpert,
  approvalMode,
  onChangeApprovalMode,
  profilePinned,
  onResetProfile,
  features,
}: {
  isRequesting: boolean
  isStreaming: boolean
  isAwaitingApproval: boolean
  isAwaitingInput: boolean
  hasMessages: boolean
  /** Optional strip rendered just above the composer (plan status, etc.).
   *  Absent = nothing rendered — non-chat reuse stays untouched. */
  topSlot?: React.ReactNode
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
  /** Dims the send button (and drops Enter) while the view's form still owes a
   *  choice — the welcome page's project mode with no project picked. The input
   *  stays usable: the user writes first, picks the project, then sends. */
  sendBlocked?: boolean
  /** Identity hue of the project the view belongs to: the send button then takes
   *  that project's color (see Composer). Absent for a plain conversation. */
  sendAccentHue?: number
  /** Re-runs the autoFocus rule whenever the value changes. The underlying
   *  Sender only honors autoFocus on mount, so a surface that re-enters the
   *  auto-focus state without remounting — the welcome composer still up while
   *  the chat view is reshown, or a fresh project preselected into the
   *  new-task state — signals through this token instead. */
  focusToken?: string | number
  /** Expert bound to the active conversation (legacy @-summon binding; new
   *  summons delegate via spawn_agent and never bind); shows the chip. */
  boundExpertId?: string
  /** Clear the bound expert (chip ×). */
  onUnbindExpert?: () => void
  /** How tool calls are approved for this conversation — the effective mode,
   *  i.e. the project's policy when the conversation belongs to one. */
  approvalMode?: SandboxApprovalMode
  /** Pick a different level. */
  onChangeApprovalMode?: (mode: SandboxApprovalMode) => void
  /** The active conversation carries its own model choice — the picker then
   *  also offers 跟随默认模型, so the pin is reversible. */
  profilePinned?: boolean
  /** Drop the conversation's own model choice (follow the global default). */
  onResetProfile?: () => void
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
  /** The composer's textarea, driven by the autoFocus rule below. */
  const composerRef = useRef<ComposerHandle>(null)

  // The autoFocus rule, made re-runnable: on mount (Sender's own autoFocus
  // covers that, this is idempotent) and again on every focusToken change.
  // No-op while the rule is off (hasMessages / explicit autoFocus={false}).
  const shouldAutoFocus = autoFocus ?? !hasMessages
  useEffect(() => {
    if (shouldAutoFocus) composerRef.current?.focus()
  }, [focusToken, shouldAutoFocus])

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
  const mentionPopupRef = useRef<HTMLDivElement | null>(null)
  // The popup is derived from the text, so the token a selection just wrote
  // (`@写作专家 `) would re-arm it — its query exactly matches the inserted
  // name. Selection and Escape park the current text here to keep the popup
  // shut; any further edit produces a different string and re-arms normally.
  const [mentionDismissedValue, setMentionDismissedValue] = useState<string | null>(null)
  const atIdx = inputValue.lastIndexOf('@')
  const mentionActive =
    showExperts &&
    atIdx >= 0 &&
    (atIdx === 0 || /\s/.test(inputValue[atIdx - 1])) &&
    inputValue !== mentionDismissedValue
  const mentionQuery = mentionActive ? inputValue.slice(atIdx + 1) : ''
  const mentionMatches = useMemo((): ExpertProfile[] => {
    if (!mentionActive) return []
    const q = mentionQuery.trim().toLowerCase()
    return (q
      ? summonableExperts.filter((e) => e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q))
      : summonableExperts
    ).slice(0, 8)
  }, [mentionActive, mentionQuery, summonableExperts])

  const handleInputChange = (v: string): void => {
    setInputValue(v)
    setMentionNavIdx(0)
  }

  const selectMention = (expert: ExpertProfile): void => {
    const next = `${inputValue.slice(0, atIdx)}@${expert.name} `
    setInputValue(next)
    setMentionDismissedValue(next)
  }

  // Arrow keys move the highlight, and the popup is a maxHeight+overflow box,
  // so the highlighted row can leave the visible rows. Reveal it by writing the
  // popup's own scrollTop — scrollIntoView is not scoped to the popup and would
  // also drag the chat pane's scroller sitting behind it.
  useEffect(() => {
    const popup = mentionPopupRef.current
    if (!popup || !mentionActive) return
    const item = popup.querySelector<HTMLElement>(`[data-mention-idx="${mentionNavIdx}"]`)
    if (!item) return
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < popup.scrollTop) popup.scrollTop = top
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight
  }, [mentionNavIdx, mentionActive, mentionMatches])

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
  // A pinned conversation can drop its own choice and follow the global
  // default again. Only shown while pinned, or the item would offer to undo
  // nothing (and read as a second, confusing "default" entry).
  if (profilePinned && onResetProfile) {
    modelItems.push({
      key: '__follow_default__',
      label: t('chatView.model.followDefault'),
      onClick: onResetProfile,
    })
  }

  const hasAttachments = selectedFiles.length + selectedFolders.length > 0

  const handleComposerKeyDown = (e: React.KeyboardEvent<Element>): false | void => {
    // @-popup owns the navigation keys while it's open — including Enter, which
    // picks the highlighted expert instead of sending — and the input-history
    // hook must not eat ArrowUp/Down then. IME composition keys (candidate
    // navigation, the Enter that confirms pinyin) belong to the IME, not the
    // popup. Returning false is Sender's own veto contract for "don't submit":
    // preventDefault alone never reaches its internal handler.
    if (mentionActive && mentionMatches.length > 0 && !e.nativeEvent.isComposing) {
      const picked = mentionMatches[mentionNavIdx]
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setMentionNavIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
          return false
        case 'ArrowDown':
          e.preventDefault()
          setMentionNavIdx((i) => (i + 1) % mentionMatches.length)
          return false
        case 'Enter':
          // Shift/modified Enter is a newline or an editor shortcut, not a pick.
          if (picked && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault()
            selectMention(picked)
            return false
          }
          break
        case 'Escape':
          e.preventDefault()
          // Dismiss rather than select — the hatch for an @name typed by hand:
          // the next Enter sends the text instead.
          setMentionDismissedValue(inputValue)
          return false
      }
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
      <Composer
        ref={composerRef}
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={submit}
        onCancel={onCancel}
        isRequesting={isRequesting}
        disabled={isInputDisabled}
        sendBlocked={sendBlocked}
        sendAccentHue={sendAccentHue}
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
        aboveCard={
          // The @-mention selector and the caller's topSlot (plan strip) float
          // just above the input card. The slot must anchor to the card's own
          // box, not to this wrapper: in the floating layout the composer is
          // absolute and out of flow, which collapses the wrapper to zero
          // height — an anchor there landed on the pane bottom and painted
          // both overlays on top of the input card. Composer.aboveCard owns
          // the correct anchor (see its doc); here both children stack in
          // document order, popup closest to the card.
          (topSlot || (mentionActive && mentionMatches.length > 0)) && (
            <>
              {topSlot && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>{topSlot}</div>
              )}
              {mentionActive && mentionMatches.length > 0 && (
                <div
                  ref={mentionPopupRef}
                  data-mention-popup
                  style={{
                    // Mirror the visible .ant-sender box (COMPOSER_MAX_WIDTH,
                    // centered): the column is wider, so plain width would let
                    // the selector outgrow the input box it belongs to.
                    // position:relative makes the rows' offsetTop popup-relative,
                    // which the keyboard-scroll effect below reads.
                    position: 'relative',
                    maxWidth: COMPOSER_MAX_WIDTH,
                    margin: '0 auto',
                    maxHeight: 264,
                    overflow: 'auto',
                    background: 'var(--pm-elevated)',
                    border: '1px solid var(--pm-border-veil)',
                    borderRadius: 10,
                    boxShadow: 'var(--pm-shadow-pop)',
                    padding: 4,
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', padding: '4px 8px 2px' }}>{t('chatView.expert.summonTitle')}</div>
                  {/* What a summon will DO, because the two shapes differ: one
                      expert answers in their own words, several become a plan.
                      Without it a second name reads as a second answer rather
                      than a different mode. ABOVE the list on purpose: this box
                      is the scroll container (maxHeight + overflow), so a
                      footnote below eight rows is only reachable by scrolling —
                      the legend has to be there the moment `@` opens it. */}
                  <div style={{ padding: '2px 8px 4px', fontSize: 11, color: 'var(--pm-text-muted)', lineHeight: 1.6 }}>
                    <div>{t('chatView.expert.summonHintOne')}</div>
                    <div>{t('chatView.expert.summonHintMany')}</div>
                  </div>
                  {mentionMatches.map((expert, i) => (
                    <div
                      key={expert.id}
                      data-mention-idx={i}
                      onClick={() => selectMention(expert)}
                      onMouseEnter={() => setMentionNavIdx(i)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: i === mentionNavIdx ? 'var(--pm-hover-weak)' : 'transparent',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expert.name}</div>
                        {expert.description && (
                          <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expert.description}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
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
                    background: 'var(--pm-pill)',
                    border: '1px solid var(--pm-border-veil-weak)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                    maxWidth: 220,
                  }}
                  title={boundExpert.description || boundExpert.name}
                >
                  <span style={{ fontSize: 13, lineHeight: 1 }}>
                    <UserOutlined style={{ fontSize: 11, color: 'var(--pm-text-secondary)' }} />
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{boundExpert.name}</span>
                  <span
                    onClick={onUnbindExpert}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
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
                    background: 'var(--pm-pill-strong)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FolderOutlined style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFolder(i)}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
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
                    background: 'var(--pm-pill-strong)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FileOutlined style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFile(i)}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
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
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<FolderOutlined style={{ fontSize: 14 }} />}
                  onClick={handlePickFolder}
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
                />
              </>
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
                  <DownOutlined style={{ fontSize: 10, color: 'var(--pm-text-faint)', marginLeft: 4 }} />
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
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
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
