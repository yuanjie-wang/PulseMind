/**
 * The input composer shell: an antd `Sender` with the app's chrome (frosted
 * glass card, pill radius, soft shadow) and the send/stop button, shared by the
 * main chat and the tool studio so both look and behave identically.
 *
 * Callers own their value and submit semantics; `footerLeft` is where the chat
 * hangs its attachment buttons, `trailing` is the right cluster it builds in
 * front of the send button (context ring, model picker). The studio passes
 * neither and gets the bare composer. The forwarded ref is the Sender's own, so
 * a caller can drive the textarea imperatively (focus after an insert).
 */
import React, { forwardRef, useEffect, useRef, useState } from 'react'
import { Sender } from '@ant-design/x'
import { Button } from 'antd'
import { ArrowUpOutlined, LoadingOutlined } from '@ant-design/icons'
import { hsvToCss } from '../../../../shared/hash-color'

/** The Sender's imperative handle. Derived from the component itself because the
 *  package root exports `SenderProps` but not `SenderRef`. */
export type ComposerHandle = React.ElementRef<typeof Sender>

/** Visible width cap of the input card (the .ant-sender rule below) — one
 *  content column everywhere. InputArea's @-mention selector mirrors it so
 *  the popup is exactly as wide as the input box it belongs to. */
export const COMPOSER_MAX_WIDTH = 952

/** How dim the send button goes while it cannot be pressed.
 *  antd's own disabled styling is not available to it: AppLayout's stylesheet
 *  repaints every primary button black with `!important`, which outranks the
 *  disabled tokens, so a disabled circle still paints the enabled one byte for
 *  byte (measured: `rgb(0,0,0)` at opacity 1 in both states). Opacity is the
 *  property that ruleset leaves alone — hence the dimming rides it. */
const SEND_DISABLED_OPACITY = 0.35

/** Filled send button in a project's identity color (the hue its welcome card
 *  already wears). A filled circle carries the white arrow, so the fill is that
 *  hue at full saturation and a deliberately low value — which is what keeps
 *  the ink legible for *every* hue rather than only for the blues. Hovering
 *  deepens it (v .58 → .48) rather than lightening it the way the app's own
 *  black button does (#000 → #333): a lifted saturated fill washes out and, on
 *  yellow and green, drops the ink below 3:1 — while going deeper keeps the
 *  floor in *both* states, which is the invariant the probe sweeps. */
const ACCENT_SATURATION = 0.9
const ACCENT_VALUE = 0.58
const ACCENT_VALUE_HOVER = 0.48

/** The send button's fill pair for an identity hue. Exported because the
 *  contrast floor above is a contract of this palette, not a detail of one
 *  render: `scripts/probe-sidebar-newtask.mjs` sweeps all 360 hues against it. */
export function sendAccent(hue: number): { fill: string; hover: string } {
  return {
    fill: hsvToCss(hue, ACCENT_SATURATION, ACCENT_VALUE),
    hover: hsvToCss(hue, ACCENT_SATURATION, ACCENT_VALUE_HOVER),
  }
}

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
  /** Dims the send button and drops Enter, leaving the textarea usable — for a
   *  task form that still owes a choice (the welcome page's project pick). */
  sendBlocked?: boolean
  /** Identity hue of the project this composer belongs to, or undefined for a
   *  plain conversation / project mode with nothing picked yet: the send button
   *  then takes that project's color, the same one its welcome card wears. */
  sendAccentHue?: number
  loading?: boolean
  placeholder?: string
  /** Rendered inside the card above the textarea (attachment chips). */
  header?: React.ReactNode
  /** Extra footer content, left of the send button (chat: attachment buttons). */
  footerLeft?: React.ReactNode
  /** Right-aligned footer content just before the send button (chat: context
   *  ring, then the model picker). */
  trailing?: React.ReactNode
  /** Content floated just above the input card — the @-mention selector, the
   *  plan strip. Anchored to the inner column, the one box whose height tracks
   *  the card in BOTH layouts: InputArea's own wrapper cannot do this, because
   *  the floating composer is `position: absolute` and out of flow, which
   *  collapses the wrapper to zero height — a `bottom: calc(100% + …)` anchor
   *  there degenerates to the pane bottom and paints the popup on top of the
   *  card (measured, scripts/probe-mention-position.mjs). */
  aboveCard?: React.ReactNode
  /** 'floating' pins the composer to the bottom of the view (chat);
   *  'inline' lays it out in place (studio panel). */
  layout?: 'floating' | 'inline'
  maxRows?: number
  /** Pre-submit key handling on the textarea. May return `false` to veto the
   *  Sender's Enter-submit — preventDefault alone cannot reach it (this is how
   *  InputArea's @-popup turns Enter into "select the highlighted expert").
   *  `false | void` is Sender's own declared contract, not our invention. */
  onKeyDown?: (e: React.KeyboardEvent<Element>) => false | void
  /** Focus the textarea once mounted. */
  autoFocus?: boolean
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSubmit,
    onCancel,
    isRequesting,
    disabled,
    sendBlocked,
    sendAccentHue,
    loading,
    placeholder,
    header,
    footerLeft,
    trailing,
    aboveCard,
    layout = 'floating',
    maxRows = 8,
    onKeyDown,
    autoFocus,
  }: ComposerProps,
  ref
): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isWin, setIsWin] = useState(false)

  useEffect(() => {
    window.electronAPI
      .getPlatformInfo()
      .then((info) => setIsWin(info.platform === 'win32'))
      .catch(() => {
        /* default to the frosted look */
      })
  }, [])

  useEffect(() => {
    if (!autoFocus) return
    containerRef.current?.querySelector('textarea')?.focus()
  }, [autoFocus])

  // Two reasons not to send — an empty box and a form that still owes a choice
  // (the welcome page's project pick) — and one disabled look for both: a button
  // that cannot be pressed may not read as one that can.
  const sendDisabled = !isRequesting && (!value.trim() || sendBlocked)

  // A project task wears its project's color, and only while one is picked: the
  // hue is undefined for a plain conversation, so the button stays the app's
  // black — and in project mode it stays black until a card is chosen, which is
  // what makes the color arriving read as "this task now belongs to Alpha".
  const accent = sendAccentHue === undefined ? null : sendAccent(sendAccentHue)

  const send = (): void => {
    if (isRequesting) {
      onCancel()
      return
    }
    // Greyed button, and Enter has to agree with it: a form that still needs a
    // project chosen must not send through the keyboard either.
    if (sendBlocked) return
    if (!value.trim()) return
    onSubmit(value)
  }

  return (
    <div
      ref={containerRef}
      style={
        layout === 'floating'
          ? { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10, padding: '12px 24px 24px' }
          : undefined
      }
    >
      <div style={{ position: 'relative', ...(layout === 'floating' ? { maxWidth: 1000, margin: '0 auto' } : null) }}>
        {/* The above-card slot anchors here — this column hugs the Sender card
            exactly (the root adds 36px of floating padding around it), so
            `bottom: calc(100% + 8px)` lands 8px above the card in both
            layouts, and the card's growth (attachment chips, autosize rows)
            carries the slot up with it. */}
        {aboveCard && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, zIndex: 100 }}>
            {aboveCard}
          </div>
        )}
        <Sender
          ref={ref}
          autoSize={{ minRows: 1, maxRows }}
          header={header}
          footer={
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {footerLeft}
              {/* The trailing cluster and the send button share one auto-margined
                  group, so the cluster lands against the button's left edge. The
                  margin has to sit on the group: on the button it would open the
                  gap between the two instead. The button is antd's 24px size="small"
                  circle; the ring is deliberately drawn a touch smaller than that. */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                {trailing}
                <Button
                  size="small"
                  type="primary"
                  shape="circle"
                  className={accent ? 'pm-accent-send' : 'pm-send'}
                  icon={isRequesting ? <LoadingOutlined /> : <ArrowUpOutlined />}
                  disabled={sendDisabled}
                  style={
                    {
                      opacity: sendDisabled ? SEND_DISABLED_OPACITY : 1,
                      // The fill itself cannot ride this style object: antd's own
                      // primary rules (base, :hover, :disabled) would each fight
                      // an inline declaration per-state. It travels as a custom
                      // property instead, consumed by the !important rules below,
                      // which outrank every one of those states at once.
                      ...(accent
                        ? { '--pm-send-accent': accent.fill, '--pm-send-accent-hover': accent.hover }
                        : null),
                    } as React.CSSProperties
                  }
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
          onSubmit={(val) => {
            if (val && typeof val === 'string') send()
          }}
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
          /* One content column everywhere: as wide as the chat message column
             (maxWidth 1000 minus its 24px paddings) and the welcome cards. */
          max-width: ${COMPOSER_MAX_WIDTH}px;
          margin: 0 auto;
          box-shadow: 0 5px 20px 2px rgb(80 100 200 / 20%) !important;
        }
        /* The send button's fills. The base circle is black from the antd theme
           (colorPrimary); pm-send lands only on that plain circle, so its
           disabled rule cannot leak onto the accent one. The accent rules exist
           so the project hue can beat antd's own primary states — !important
           outranks the plain cascade, including antd's :disabled, which is how
           the hue survives a blocked send. The disabled case is pinned to the
           enabled fill on purpose: the dim language here is the solid fill at
           reduced opacity, not antd's washed-grey disabled paint, so a project
           task with an empty box reads as its own color, dimmed. */
        .ant-btn-primary.pm-send:disabled {
          background: #000 !important;
          border-color: #000 !important;
          color: #fff !important;
        }
        .ant-btn-primary.pm-accent-send {
          background: var(--pm-send-accent) !important;
          border-color: var(--pm-send-accent) !important;
        }
        .ant-btn-primary.pm-accent-send:not(:disabled):hover {
          background: var(--pm-send-accent-hover) !important;
          border-color: var(--pm-send-accent-hover) !important;
        }
      `}</style>
    </div>
  )
})

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

  const onKeyDown = (e: React.KeyboardEvent<Element>, value: string, setValue: (v: string) => void): void => {
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
