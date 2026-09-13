/**
 * The input composer shell: an antd `Sender` with the app's chrome (frosted
 * glass card, pill radius, soft shadow) and the send/stop button, shared by the
 * main chat and the tool studio so both look and behave identically.
 *
 * Callers own their value and submit semantics; `footerLeft` is where the chat
 * hangs its attachment / model pickers, `trailing` is where it puts the context
 * ring. The studio passes neither and gets the bare composer.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Sender } from '@ant-design/x'
import { Button } from 'antd'
import { ArrowUpOutlined, LoadingOutlined } from '@ant-design/icons'

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  /** Called with the trimmed value when the user sends (button or Enter). */
  onSubmit: (value: string) => void
  /** Called instead of submit while a request is in flight (the stop button). */
  onCancel: () => void
  isRequesting: boolean
  /** Blocks input entirely (e.g. a pending approval dialog owns the turn). */
  disabled?: boolean
  loading?: boolean
  placeholder?: string
  /** Rendered inside the card above the textarea (attachment chips). */
  header?: React.ReactNode
  /** Extra footer content, left of the send button (chat: pickers + ring). */
  footerLeft?: React.ReactNode
  /** Right-aligned footer content just before the send button (context ring). */
  trailing?: React.ReactNode
  /** 'floating' pins the composer to the bottom of the view (chat);
   *  'inline' lays it out in place (studio panel). */
  layout?: 'floating' | 'inline'
  maxRows?: number
  onKeyDown?: (e: React.KeyboardEvent<Element>) => void
  /** Focus the textarea once mounted. */
  autoFocus?: boolean
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  isRequesting,
  disabled,
  loading,
  placeholder,
  header,
  footerLeft,
  trailing,
  layout = 'floating',
  maxRows = 8,
  onKeyDown,
  autoFocus,
}: ComposerProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isWin, setIsWin] = useState(false)

  useEffect(() => {
    window.electronAPI.getPlatformInfo()
      .then((info) => setIsWin(info.platform === 'win32'))
      .catch(() => { /* default to the frosted look */ })
  }, [])

  useEffect(() => {
    if (!autoFocus) return
    containerRef.current?.querySelector('textarea')?.focus()
  }, [autoFocus])

  const send = (): void => {
    if (isRequesting) {
      onCancel()
      return
    }
    if (!value.trim()) return
    onSubmit(value)
  }

  return (
    <div
      ref={containerRef}
      style={layout === 'floating'
        ? { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10, padding: '12px 24px 24px' }
        : { padding: '8px 10px 10px', borderTop: '1px solid #f0f0f0' }}
    >
      <div style={layout === 'floating' ? { maxWidth: 1000, margin: '0 auto' } : undefined}>
        <Sender
          autoSize={{ minRows: 1, maxRows }}
          header={header}
          footer={
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {footerLeft}
              {/* The ring and the send button share one auto-margined group, so the
                  ring lands against the button's left edge. The margin has to sit on
                  the group: on the button it would open the gap between the two
                  instead. 24px is the send button's diameter (antd size="small"
                  circle), which the ring matches. */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                {trailing}
                <Button
                  size="small"
                  type="primary"
                  shape="circle"
                  icon={isRequesting ? <LoadingOutlined /> : <ArrowUpOutlined />}
                  disabled={!isRequesting && !value.trim()}
                  onClick={send}
                />
              </div>
            </div>
          }
          value={value}
          onChange={(v) => onChange(v as string)}
          loading={loading}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={onKeyDown}
          onSubmit={(val) => { if (val && typeof val === 'string') send() }}
          onCancel={onCancel}
        />
      </div>

      <style>{`
        .ant-sender-actions-btn { display: none !important; }
        .ant-sender {
          background: ${isWin ? '#fff' : 'rgba(255,255,255,0.85)'} !important;
          ${isWin ? '' : 'backdrop-filter: blur(12px);'}
          ${isWin ? '' : '-webkit-backdrop-filter: blur(12px);'}
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 20px !important;
          max-width: 750px;
          margin: 0 auto;
          box-shadow: 0 5px 20px 2px rgb(80 100 200 / 20%) !important;
        }
      `}</style>
    </div>
  )
}

/**
 * Input history for a composer: ArrowUp walks back through what was sent,
 * ArrowDown returns to the draft. Shared so both composers behave the same.
 */
export function useInputHistory() {
  const historyRef = useRef<string[]>([])
  const indexRef = useRef(-1)
  const draftRef = useRef('')

  const push = (message: string): void => {
    const last = historyRef.current[historyRef.current.length - 1]
    if (historyRef.current.length === 0 || last !== message) {
      historyRef.current.push(message)
    }
    indexRef.current = -1
  }

  const onKeyDown = (
    e: React.KeyboardEvent<Element>,
    value: string,
    setValue: (v: string) => void,
  ): void => {
    if (e.key === 'ArrowUp') {
      if (historyRef.current.length === 0) return
      e.preventDefault()
      if (indexRef.current === -1) {
        draftRef.current = value
        indexRef.current = historyRef.current.length - 1
      } else if (indexRef.current > 0) {
        indexRef.current--
      } else {
        return
      }
      setValue(historyRef.current[indexRef.current])
    } else if (e.key === 'ArrowDown') {
      if (indexRef.current === -1) return
      e.preventDefault()
      if (indexRef.current < historyRef.current.length - 1) {
        indexRef.current++
        setValue(historyRef.current[indexRef.current])
      } else {
        indexRef.current = -1
        setValue(draftRef.current)
      }
    }
  }

  return { push, onKeyDown }
}
