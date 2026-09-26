// ── Command palette (Cmd/Ctrl+K) ──
// One panel that eats most of the sidebar's navigation burden: fixed actions,
// views, open conversations, projects and every settings section behind one
// query box. The item/fuzzy halves are pure (navigation/command-palette-items.ts);
// this shell renders the filtered list and runs the picked item.
//
// Keyboard contract: the accelerator lives in the app menu (mac) / the
// before-input fallback (Windows/Linux) — this component only handles the
// in-panel keys (↑/↓ move, Enter runs, Escape closes via Modal). Mounted
// always; a closed Modal renders nothing.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input, Modal } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import { useCommandPaletteStore } from '../../stores/commandPaletteStore'
import { filterCommandItems, type CommandItem } from '../../navigation/command-palette-items'

function CommandPalette({ items }: { items: CommandItem[] }): React.ReactElement {
  const { t } = useTranslation()
  const open = useCommandPaletteStore((s) => s.open)
  const setOpen = useCommandPaletteStore((s) => s.setOpen)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => filterCommandItems(items, query), [items, query])

  // A fresh open (and each new query) starts the cursor at the top. Adjusted
  // during render — the documented adjust-state-on-prop-change pattern
  // (App.tsx) — because an effect would fire after a paint of the stale list.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      setActiveIdx(0)
    }
  }
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setActiveIdx(0)
  }

  // Keep the active row visible while arrowing past the scrollport.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, results.length])

  const runItem = (item: CommandItem): void => {
    setOpen(false)
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[activeIdx]
      if (item) runItem(item)
    }
  }

  let lastGroup: string | null = null

  // `content` was an antd-5 key this antd-6 Modal ignores at runtime —
  // dropped rather than renamed, so today's rendering does not change.
  return (
    <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        closable={false}
        width={520}
        styles={{ body: { padding: 0 } }}
      >
      <Input
        autoFocus
        variant="borderless"
        size="large"
        placeholder={t('palette.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div ref={listRef} className="auto-hide-scroll" style={{ maxHeight: 340, overflow: 'auto', marginTop: 4 }}>
        {results.length === 0 ? (
          <div style={{ padding: '20px 12px 16px', color: 'var(--pm-text-muted)', fontSize: 13, textAlign: 'center' }}>{t('palette.empty')}</div>
        ) : (
          results.map((item, idx) => {
            const showGroup = item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.id}>
                {showGroup && (
                  <div
                    style={{
                      padding: '8px 12px 2px',
                      fontSize: 11,
                      color: 'var(--pm-text-muted)',
                      fontWeight: 600,
                      letterSpacing: 0.3,
                    }}
                  >
                    {item.group}
                  </div>
                )}
                <div
                  data-idx={idx}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => runItem(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: idx === activeIdx ? 'var(--pm-hover)' : 'transparent',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, color: 'var(--pm-text-title)' }}>
                    {item.label}
                  </span>
                  {item.hint && <span style={{ fontSize: 11, color: 'var(--pm-text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{item.hint}</span>}
                </div>
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}

export default CommandPalette
