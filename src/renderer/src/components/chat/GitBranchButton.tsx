// Composer footer git branch picker. Anchor ① of the git-support design
// (2026-11-21): only project-bound conversations mount it, and a non-repo
// project renders nothing at all. Reads (status/branch_list) and writes
// (switch/branch_create) both ride the existing GIT_INVOKE channel, so the
// agent's git tools and this UI share one service, one jail and one audit path.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Modal, Popover, Spin } from 'antd'
import { BranchesOutlined, CheckOutlined, DownOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { useGitBranch } from '../../hooks/useGitBranch'
import type { GitAction, GitBranchEntry } from '../../../../shared/types/git'

// InputArea owns UNRESTRICTED_COLOR but importing it here would be a cycle.
// Keep the literal in step with InputArea.tsx:63.
const WARN = 'var(--pm-warn)'

// A row needs a real :hover, which inline styles cannot express. Three
// highlight levels are deliberately distinct so nothing reads as "light grey
// ink sitting on a light grey wash": current = themed link tint, keyboard
// active = strong wash, hover = light wash. All colours are theme variables
// (palette.ts defines each for light AND dark), never hard-coded hex.
const BRANCH_ROW_CSS = `
.pm-git-branch-row { border-radius: 6px; }
.pm-git-branch-row-sub { color: var(--pm-text-quiet); }
.pm-git-branch-row-active { background: var(--pm-hover-strong); }
.pm-git-branch-row-current {
  background: var(--pm-link-bg);
}
.pm-git-branch-row-current .pm-git-branch-row-name { color: var(--pm-link); }
.pm-git-branch-row:hover { background: var(--pm-hover); }
.pm-git-branch-row-active:hover { background: var(--pm-hover-strong); }
.pm-git-branch-row-current:hover { background: var(--pm-link-bg); }
.pm-git-branch-row:hover .pm-git-branch-row-sub { color: var(--pm-text-secondary); }
`

interface Props {
  /** Project binding. Absent = plain conversation = no picker. */
  gitProjectId: string
  /** Fallback cwd while the project list is still loading. */
  workspaceDir?: string
  /** A running turn gets its own confirmation before a switch. */
  isRequesting: boolean
}

interface ConfirmOpts {
  title: string
  content: string
  okText: string
}

export function GitBranchButton({ gitProjectId, workspaceDir, isRequesting }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { cwd, status, branches, loading, refresh } = useGitBranch(gitProjectId, workspaceDir, open)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  // A controlled Popover with trigger=[] does NOT get antd's outside-click
  // close (same finding as the voice guide in InputArea.tsx:336-360). Install
  // the two disappear paths by hand: pointerdown in the capture phase, Esc.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (btnRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.pm-git-branch-pop')) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const dirtyCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0)
  const conflictCount = status?.conflict.length ?? 0
  const isEmptyRepo = !!branches && branches.head === null && branches.local.length === 0
  const currentName = branches?.detached
    ? `${t('chatView.gitBranch.detached')}${branches.head ? `@${branches.head}` : ''}`
    : (branches?.current ?? status?.branch ?? '—')

  const filteredLocal = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = branches?.local ?? []
    return q ? list.filter((b) => `${b.name} ${b.summary}`.toLowerCase().includes(q)) : list
  }, [branches, query])
  const filteredRemote = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = branches?.remote ?? []
    return q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list
  }, [branches, query])

  const confirmAction = useCallback(
    (opts: ConfirmOpts): Promise<boolean> =>
      new Promise((resolve) => {
        Modal.confirm({
          title: opts.title,
          content: opts.content,
          okText: opts.okText,
          okButtonProps: { danger: true },
          cancelText: t('common.cancel'),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      }),
    [t],
  )

  const doSwitch = useCallback(
    async (name: string, create = false): Promise<void> => {
      if (!cwd || busy) return
      if (conflictCount > 0) {
        notify.warning(t('chatView.gitBranch.conflictBody'))
        return
      }
      // Running turn: the work tree changes under the agent mid-flight.
      if (isRequesting) {
        const allowed = await confirmAction({
          title: t('chatView.gitBranch.runningTitle'),
          content: t('chatView.gitBranch.runningBody'),
          okText: t('chatView.gitBranch.runningOk'),
        })
        if (!allowed) return
      }
      // Uncommitted changes follow the switch (git's default). No stash in P0 —
      // the user can cancel and commit first; a conflicting target makes git
      // refuse the switch and the error reaches the toast verbatim.
      if (dirtyCount > 0) {
        const allowed = await confirmAction({
          title: t('chatView.gitBranch.dirtyTitle'),
          content: t('chatView.gitBranch.dirtyBody', { count: dirtyCount, branch: name }),
          okText: t('chatView.gitBranch.dirtyOk'),
        })
        if (!allowed) return
      }
      setBusy(true)
      try {
        const action: GitAction = create
          ? { action: 'branch_create', cwd, name }
          : { action: 'switch', cwd, name }
        const r = await window.electronAPI.gitInvoke(action)
        if (!r.ok) throw new Error(r.error?.message ?? 'unknown git error')
        notify.success(t(create ? 'chatView.gitBranch.createdOk' : 'chatView.gitBranch.switchOk', { branch: name }))
        setOpen(false)
        setNewName('')
        await refresh()
      } catch (err) {
        notify.error(t('chatView.gitBranch.failed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        setBusy(false)
      }
    },
    [cwd, busy, conflictCount, isRequesting, dirtyCount, t, confirmAction, refresh],
  )

  const createBranch = (): void => {
    const name = newName.trim()
    if (!name || busy || isEmptyRepo) return
    void doSwitch(name, true)
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, filteredLocal.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filteredLocal[activeIdx]
      if (target && !target.current) void doSwitch(target.name)
      else if (!target) createBranch()
    }
  }

  if (!cwd || !status?.isRepo || !branches?.isRepo) return null

  // The outer chip shows ONLY the branch name (user ruling 2026-11-21).
  // Statuses live in the panel's status block, and the full name is available
  // here because the chip ellipsizes long branch names.
  const buttonTitle = `${t('chatView.gitBranch.label')}: ${currentName}`

  const renderRow = (b: GitBranchEntry, idx: number, remote: boolean): React.ReactNode => (
    <div
      key={b.name}
      role="button"
      tabIndex={-1}
      className={`pm-git-branch-row${b.current ? ' pm-git-branch-row-current' : ''}${idx === activeIdx && !remote ? ' pm-git-branch-row-active' : ''}`}
      title={remote ? t('chatView.gitBranch.remoteReadonly') : b.name}
      // Mouse and keyboard share ONE active index (same rule as the @-mention
      // popup): hovering never leaves a second row highlighted.
      onMouseEnter={() => {
        if (!remote) setActiveIdx(idx)
      }}
      onClick={() => {
        if (!remote && !b.current) void doSwitch(b.name)
      }}
      style={{ padding: '5px 8px', cursor: remote || b.current ? 'default' : 'pointer' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
        <span className="pm-git-branch-row-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {b.current && <CheckOutlined style={{ fontSize: 10, marginRight: 4 }} />}
          {b.name}
          {b.current && <span style={{ fontSize: 11, color: 'var(--pm-link)', marginLeft: 6 }}>{t('chatView.gitBranch.current')}</span>}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--pm-text-quiet)' }}>
          {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
        </span>
      </div>
      {b.summary && (
        <div className="pm-git-branch-row-sub" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {b.summary}
        </div>
      )}
    </div>
  )

  const panel = (
    <div style={{ width: 300 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{t('chatView.gitBranch.panelTitle')}</span>
        <Button
          type="text"
          size="small"
          title={t('chatView.gitBranch.refresh')}
          icon={loading ? <Spin size="small" /> : <ReloadOutlined />}
          onClick={() => void refresh()}
        />
      </div>
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 8,
          // A bordered card, not a grey wash: the old `--pm-hover` fill sat at
          // almost the same value as the faint helper text and made the whole
          // block read as a blur. Both variables have light/dark definitions.
          background: 'var(--pm-elevated)',
          border: '1px solid var(--pm-border-veil)',
          marginBottom: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontFamily: 'monospace', fontWeight: 500 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentName}</span>
          {conflictCount > 0 && <span style={{ color: WARN, fontSize: 11 }}>!{conflictCount}</span>}
          {dirtyCount > 0 && <span style={{ color: WARN, fontSize: 11 }}>● {dirtyCount}</span>}
          {status.ahead > 0 && <span style={{ fontSize: 11, color: 'var(--pm-text-quiet)' }}>↑{status.ahead}</span>}
          {status.behind > 0 && <span style={{ fontSize: 11, color: 'var(--pm-text-quiet)' }}>↓{status.behind}</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--pm-text-quiet)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd}>
          {cwd}
        </div>
        <div style={{ fontSize: 11, color: 'var(--pm-text-quiet)', marginTop: 2 }}>{t('chatView.gitBranch.sharedHint')}</div>
      </div>
      <Input
        size="small"
        value={query}
        placeholder={t('chatView.gitBranch.search')}
        onChange={(e) => {
          setQuery(e.target.value)
          setActiveIdx(0)
        }}
        onKeyDown={onSearchKeyDown}
        style={{ marginBottom: 8 }}
      />
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: 'var(--pm-text-quiet)', padding: '4px 8px' }}>
          {t('chatView.gitBranch.local')} ({filteredLocal.length})
        </div>
        {filteredLocal.length === 0 && (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--pm-text-quiet)' }}>
            {isEmptyRepo ? t('chatView.gitBranch.emptyRepo') : t('chatView.gitBranch.noBranches')}
          </div>
        )}
        {filteredLocal.map((b, idx) => renderRow(b, idx, false))}
        {filteredRemote.length > 0 && (
          <>
            <div
              role="button"
              tabIndex={-1}
              onClick={() => setRemoteOpen((v) => !v)}
              style={{ fontSize: 11, color: 'var(--pm-text-quiet)', padding: '8px 8px 4px', cursor: 'pointer' }}
            >
              {t('chatView.gitBranch.remote')} ({filteredRemote.length}) {remoteOpen ? '▾' : '▸'}
            </div>
            {remoteOpen && filteredRemote.map((b, idx) => renderRow(b, idx, true))}
          </>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--pm-border-veil)', marginTop: 8, paddingTop: 9, display: 'flex', gap: 6 }}>
        <Input
          size="small"
          value={newName}
          disabled={isEmptyRepo || busy}
          placeholder={isEmptyRepo ? t('chatView.gitBranch.emptyRepo') : t('chatView.gitBranch.newBranchPlaceholder')}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={createBranch}
        />
        <Button size="small" type="primary" loading={busy} disabled={!newName.trim() || isEmptyRepo || busy} onClick={createBranch}>
          {t('chatView.gitBranch.create')}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {/* The panel is portaled to body, so row :hover cannot ride an inline
          style. Injected once per mounted composer; the rules are idempotent. */}
      <style>{BRANCH_ROW_CSS}</style>
      <Popover content={panel} open={open} trigger={[]} placement="topLeft" overlayClassName="pm-git-branch-pop">
        <Button
          ref={btnRef}
          size="small"
          type="text"
          className="pm-chat-branch"
          title={buttonTitle}
          aria-label={buttonTitle}
          onClick={() => setOpen((v) => !v)}
          style={{ fontSize: 12, color: 'var(--pm-text-secondary)', maxWidth: 190 }}
        >
          {/* Only the branch name is shown outside (user ruling 2026-11-21):
              no dirty count, no ahead/behind, no conflict badge. Those live in
              the panel's status block. The glyph and caret are the control
              itself, not information. The label + caret shed at Composer's
              ≤500 stage (pm-branch-label), leaving the glyph at every width. */}
          <BranchesOutlined style={{ fontSize: 14 }} />
          <span className="pm-branch-label" style={{ marginLeft: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentName}
          </span>
          <DownOutlined className="pm-branch-label" style={{ fontSize: 10, color: 'var(--pm-text-faint)', marginLeft: 4 }} />
        </Button>
      </Popover>
    </>
  )
}
