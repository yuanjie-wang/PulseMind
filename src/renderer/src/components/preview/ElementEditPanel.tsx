// ── Element edit panel (PLAN-html-element-edit §设计4, M3/M5) ──
// The bottom strip inside the files tab while element mode is on: breadcrumb
// (click to select an ancestor), the AI instruction row (every element can be
// AI-edited — user ruling ②③), and the typed controls for the element's
// category. Direct edits apply to the live DOM immediately and patch the file
// in the background (D5); structural edits (delete) reload. Uncontrolled
// inputs commit on blur/Enter, selects and colors commit on change — never
// per keystroke (D5).

import React, { useState } from 'react'
import { Input, Select, Modal, message } from 'antd'
import { Undo2, RotateCcw, Trash2, ChevronRight, Sparkles } from 'lucide-react'
import { useTranslation } from '../../i18n/useTranslation'
import { useHtmlEditStore, consumeFailure, sendToFrame } from '../../stores/htmlEditStore'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'
import { runHtmlAiEdit } from '../../agent/one-shot-agent/HtmlElementEditAgent'
import { resolveElement } from '../../../../shared/html-edit/resolve'
import { useSettings } from '../../hooks/SettingsContext'
import { createLlmAdapter } from '../../llm'

const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'li', 'td', 'th', 'button', 'label',
  'blockquote', 'strong', 'em', 'b', 'i', 'u', 'small', 'code', 'figcaption', 'dt', 'dd',
  'summary', 'cite', 'q', 'time', 'pre', 'a',
])
const CONTAINER_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'main', 'nav', 'article', 'aside', 'form',
  'figure', 'table', 'tr', 'body',
])
const LIST_TAGS = new Set(['ul', 'ol'])
const FORM_TAGS = new Set(['input', 'textarea', 'select'])

type Category = 'text' | 'image' | 'list' | 'form' | 'container'

function categoryOf(tag: string): Category {
  if (tag === 'img') return 'image'
  if (LIST_TAGS.has(tag)) return 'list'
  if (FORM_TAGS.has(tag)) return 'form'
  if (TEXT_TAGS.has(tag)) return 'text'
  return 'container'
}

/** '16px' → 16; non-px or missing → '' (empty input). */
function px(value: string | undefined): string {
  if (!value) return ''
  const n = parseFloat(value)
  return Number.isFinite(n) && /px/.test(value) ? String(n) : ''
}

/** 'rgb(255, 0, 0)' / 'rgba(...)' → '#ff0000'; anything else → ''. */
function toHex(value: string | undefined): string {
  if (!value) return ''
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (!m) return ''
  return `#${m.slice(1).map((c) => parseInt(c, 10).toString(16).padStart(2, '0')).join('')}`
}

const FONT_WEIGHTS = ['300', '400', '500', '600', '700']
const ALIGN_VALUES = ['left', 'center', 'right', 'justify']
const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double']
const LIST_BULLETS = ['disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'none']

// ── Control primitives ──

const LABEL: React.CSSProperties = { fontSize: 11, color: '#888', flexShrink: 0 }
const SMALL_INPUT_STYLE: React.CSSProperties = { fontSize: 12 }

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </label>
  )
}

function TextField(props: {
  label: string
  initial: string
  width?: number
  placeholder?: string
  onCommit: (value: string) => void
}): React.ReactElement {
  const [value, setValue] = useState(props.initial)
  const commit = () => {
    if (value !== props.initial) props.onCommit(value)
  }
  return (
    <Field label={props.label}>
      <Input
        size="small"
        style={{ ...SMALL_INPUT_STYLE, width: props.width ?? 90 }}
        value={value}
        placeholder={props.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={commit}
        onBlur={commit}
      />
    </Field>
  )
}

function NumberField(props: {
  label: string
  initial: string
  onCommit: (value: string | null) => void
}): React.ReactElement {
  const [value, setValue] = useState(props.initial)
  const commit = () => {
    const trimmed = value.trim()
    if (trimmed === props.initial) return
    props.onCommit(trimmed === '' ? null : `${trimmed}px`)
  }
  return (
    <Field label={props.label}>
      <Input
        size="small"
        style={{ ...SMALL_INPUT_STYLE, width: 56 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={commit}
        onBlur={commit}
      />
    </Field>
  )
}

function ColorField(props: {
  label: string
  initial: string
  onCommit: (value: string | null) => void
}): React.ReactElement {
  const [value, setValue] = useState(props.initial)
  const commit = (next: string) => {
    setValue(next)
    props.onCommit(next === '' ? null : next)
  }
  return (
    <Field label={props.label}>
      <input
        type="color"
        value={value || '#000000'}
        onChange={(e) => commit(e.target.value)}
        style={{ width: 22, height: 22, padding: 0, border: '1px solid #d9d9d9', borderRadius: 4, background: 'none', cursor: 'pointer' }}
        title={props.label}
      />
      <Input
        size="small"
        style={{ ...SMALL_INPUT_STYLE, width: 74 }}
        value={value}
        placeholder="#RRGGBB"
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => commit(value.trim())}
        onBlur={() => {
          const trimmed = value.trim()
          if (trimmed !== props.initial && (/^#[0-9a-fA-F]{3,8}$/.test(trimmed) || trimmed === '')) commit(trimmed)
        }}
      />
    </Field>
  )
}

function SelectField(props: {
  label: string
  initial: string
  options: string[]
  onCommit: (value: string | null) => void
}): React.ReactElement {
  return (
    <Field label={props.label}>
      <Select
        size="small"
        style={{ ...SMALL_INPUT_STYLE, width: 84 }}
        value={props.initial || undefined}
        placeholder="—"
        allowClear
        onChange={(value) => props.onCommit((value as string) ?? null)}
        options={props.options.map((o) => ({ value: o, label: o }))}
      />
    </Field>
  )
}

// ── The panel ──

export function ElementEditPanel({ path }: { path: string }): React.ReactElement {
  const { t } = useTranslation()
  const { settings } = useSettings()
  const session = useHtmlEditStore((s) => s.sessions[path])
  const selection = session?.selection ?? null
  const [aiText, setAiText] = useState('')

  if (!session || !selection) {
    return (
      <div
        style={{
          flexShrink: 0,
          padding: '7px 12px',
          borderTop: '1px solid #ececf0',
          background: '#f7f8fa',
          fontSize: 12,
          color: '#999',
          textAlign: 'center',
        }}
      >
        {t('htmlEdit.hint')}
      </div>
    )
  }

  const store = useHtmlEditStore.getState()
  const previewStore = usePreviewPaneStore.getState()
  const resolved = resolveElement(session.fileText, selection.pmPath)
  const attributes = resolved.ok ? resolved.location.attributes : {}
  const hasElementChildren = resolved.ok ? resolved.location.hasScriptLikeChildren || /<[a-z]/i.test(innerOf(session.fileText, resolved.location)) : false

  const toastFail = () => {
    const reason = consumeFailure()
    if (reason) void message.error(reason)
  }

  const afterDirectEdit = (ok: boolean) => {
    if (!ok) toastFail()
  }

  const runAi = async () => {
    const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
    if (!profile?.apiKey) {
      void message.error('请先在设置中配置 API Key')
      return
    }
    const result = await runHtmlAiEdit(path, aiText, {
      llmConfig: {
        apiKey: profile.apiKey,
        baseURL: profile.baseURL || '',
        model: profile.model || '',
        adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
      },
    })
    if (result.ok) {
      setAiText('')
      previewStore.bumpReload(path)
    } else {
      void message.error(result.error)
    }
  }

  const undo = async () => {
    if (await store.undo(path)) previewStore.bumpReload(path)
    else toastFail()
  }

  const restoreOriginal = () => {
    Modal.confirm({
      title: t('htmlEdit.restoreOriginal'),
      content: t('htmlEdit.deleteConfirmBody'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (await store.restoreOriginal(path)) previewStore.bumpReload(path)
        else toastFail()
      },
    })
  }

  const deleteElement = () => {
    Modal.confirm({
      title: t('htmlEdit.deleteConfirmTitle'),
      content: t('htmlEdit.deleteConfirmBody'),
      okText: t('htmlEdit.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (await store.deleteElement(path)) previewStore.bumpReload(path)
        else toastFail()
      },
    })
  }

  const category = categoryOf(selection.tag)
  const computed = selection.computed

  const crumbs = selection.ancestors.slice(-6)
  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid #ececf0', background: '#f7f8fa', fontSize: 12 }}>
      {/* Row 1: breadcrumb + session actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px 0', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, overflow: 'hidden', flex: 1, minWidth: 0 }}>
          {crumbs.map((crumb, i) => (
            <React.Fragment key={crumb.pmPath}>
              {i > 0 && <ChevronRight size={10} style={{ color: '#bbb', flexShrink: 0 }} />}
              <span
                onClick={() => sendToFrame(path, { type: 'pm:reselect', pmPath: crumb.pmPath })}
                title={crumb.pmPath}
                style={{
                  cursor: 'pointer',
                  color: i === crumbs.length - 1 ? '#333' : '#666',
                  fontWeight: i === crumbs.length - 1 ? 600 : 400,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {crumb.tag}
                {crumb.id ? `#${crumb.id}` : ''}
                {crumb.classes.length > 0 ? `.${crumb.classes[0]}` : ''}
              </span>
            </React.Fragment>
          ))}
        </div>
        <ActionIcon title={t('htmlEdit.undo')} disabled={session.undo.length === 0} onClick={() => void undo()}>
          <Undo2 size={12} />
        </ActionIcon>
        <ActionIcon title={t('htmlEdit.restoreOriginal')} onClick={restoreOriginal}>
          <RotateCcw size={12} />
        </ActionIcon>
        <ActionIcon title={t('htmlEdit.delete')} danger onClick={deleteElement}>
          <Trash2 size={12} />
        </ActionIcon>
      </div>

      {/* Row 2: AI instruction (every element can be AI-edited) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px' }}>
        <Input
          size="small"
          style={{ fontSize: 12, flex: 1 }}
          prefix={<Sparkles size={12} style={{ color: '#999' }} />}
          placeholder={t('htmlEdit.aiPlaceholder')}
          value={aiText}
          disabled={session.aiBusy}
          onChange={(e) => setAiText(e.target.value)}
          onPressEnter={() => void runAi()}
        />
        <button
          onClick={() => void runAi()}
          disabled={session.aiBusy || !aiText.trim()}
          style={{
            flexShrink: 0,
            border: 'none',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            cursor: session.aiBusy || !aiText.trim() ? 'default' : 'pointer',
            background: session.aiBusy || !aiText.trim() ? '#d9d9d9' : '#1677ff',
            color: '#fff',
          }}
        >
          {session.aiBusy ? t('htmlEdit.aiRunning') : t('htmlEdit.aiRun')}
        </button>
      </div>
      {session.aiError && (
        <div style={{ padding: '0 8px 5px', color: '#d46b08', fontSize: 11 }}>{session.aiError}</div>
      )}

      {/* Row 3: typed controls, reset per selection */}
      <div key={selection.pmPath} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '2px 8px 8px' }}>
        {(category === 'text' || category === 'list') && !hasElementChildren && (
          <>
            <TextField
              label={t('htmlEdit.text')}
              initial={(selection.text || '').slice(0, 120)}
              width={150}
              onCommit={(value) => void store.applyText(path, value).then(afterDirectEdit)}
            />
            <button
              onClick={() => sendToFrame(path, { type: 'pm:enable-edit', pmPath: selection.pmPath })}
              style={{ border: '1px solid #d9d9d9', borderRadius: 6, background: '#fff', fontSize: 11, padding: '1px 8px', cursor: 'pointer', color: '#555', flexShrink: 0 }}
            >
              {t('htmlEdit.editInPlace')}
            </button>
          </>
        )}
        {(category === 'text' || category === 'list' || category === 'form') && (
          <>
            <NumberField label={t('htmlEdit.fontSize')} initial={px(computed['font-size'])} onCommit={(v) => void store.applyStyle(path, { 'font-size': v }).then(afterDirectEdit)} />
            <SelectField label={t('htmlEdit.fontWeight')} initial={computed['font-weight'] || ''} options={FONT_WEIGHTS} onCommit={(v) => void store.applyStyle(path, { 'font-weight': v }).then(afterDirectEdit)} />
          </>
        )}
        {category === 'form' && selection.tag !== 'select' && (
          <TextField label={t('htmlEdit.placeholder')} initial={attributes['placeholder'] ?? ''} width={110} onCommit={(value) => void store.applyAttrs(path, { placeholder: value || null }).then(afterDirectEdit)} />
        )}
        {category === 'image' && (
          <>
            <NumberField label={t('htmlEdit.width')} initial={px(computed['width'])} onCommit={(v) => void store.applyStyle(path, { width: v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.height')} initial={px(computed['height'])} onCommit={(v) => void store.applyStyle(path, { height: v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.radius')} initial={px(computed['border-radius'])} onCommit={(v) => void store.applyStyle(path, { 'border-radius': v }).then(afterDirectEdit)} />
            <TextField label={t('htmlEdit.alt')} initial={attributes['alt'] ?? ''} width={110} onCommit={(value) => void store.applyAttrs(path, { alt: value || null }).then(afterDirectEdit)} />
          </>
        )}
        {selection.tag === 'a' && (
          <>
            <TextField label={t('htmlEdit.href')} initial={attributes['href'] ?? ''} width={140} onCommit={(value) => void store.applyAttrs(path, { href: value || null }).then(afterDirectEdit)} />
            <SelectField
              label={t('htmlEdit.target')}
              initial={attributes['target'] ?? ''}
              options={['_blank']}
              onCommit={(v) => void store.applyAttrs(path, { target: v || null }).then(afterDirectEdit)}
            />
          </>
        )}
        {(category === 'text' || category === 'container' || category === 'list' || category === 'form') && (
          <>
            <ColorField label={t('htmlEdit.color')} initial={toHex(computed['color'])} onCommit={(v) => void store.applyStyle(path, { color: v }).then(afterDirectEdit)} />
            <ColorField label={t('htmlEdit.bgColor')} initial={toHex(computed['background-color'])} onCommit={(v) => void store.applyStyle(path, { 'background-color': v }).then(afterDirectEdit)} />
            <SelectField label={t('htmlEdit.align')} initial={computed['text-align'] || ''} options={ALIGN_VALUES} onCommit={(v) => void store.applyStyle(path, { 'text-align': v }).then(afterDirectEdit)} />
          </>
        )}
        {(category === 'text' || category === 'list') && (
          <NumberField label={t('htmlEdit.lineHeight')} initial={lineHeightOf(computed['line-height'])} onCommit={(v) => void store.applyStyle(path, { 'line-height': v }).then(afterDirectEdit)} />
        )}
        {category === 'list' && (
          <SelectField label={t('htmlEdit.listBullet')} initial={computed['list-style-type'] || ''} options={LIST_BULLETS} onCommit={(v) => void store.applyStyle(path, { 'list-style-type': v }).then(afterDirectEdit)} />
        )}
        {category === 'container' && (
          <>
            <NumberField label={t('htmlEdit.padding')} initial={px(computed['padding'])} onCommit={(v) => void store.applyStyle(path, { padding: v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.margin')} initial={px(computed['margin'])} onCommit={(v) => void store.applyStyle(path, { margin: v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.radius')} initial={px(computed['border-radius'])} onCommit={(v) => void store.applyStyle(path, { 'border-radius': v }).then(afterDirectEdit)} />
            <NumberField
              label={t('htmlEdit.borderWidth')}
              initial={px(computed['border-width'])}
              onCommit={(v) => {
                // A width without a style paints nothing while the computed
                // style is 'none' — promote it to solid in the same patch.
                const decls: Record<string, string | null> = { 'border-width': v }
                if (v !== null && (computed['border-style'] ?? 'none') === 'none') decls['border-style'] = 'solid'
                void store.applyStyle(path, decls).then(afterDirectEdit)
              }}
            />
            <SelectField label={t('htmlEdit.borderStyle')} initial={computed['border-style'] || ''} options={BORDER_STYLES} onCommit={(v) => void store.applyStyle(path, { 'border-style': v }).then(afterDirectEdit)} />
            <ColorField label={t('htmlEdit.borderColor')} initial={toHex(computed['border-color'])} onCommit={(v) => void store.applyStyle(path, { 'border-color': v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.width')} initial={px(computed['width'])} onCommit={(v) => void store.applyStyle(path, { width: v }).then(afterDirectEdit)} />
            <NumberField label={t('htmlEdit.height')} initial={px(computed['height'])} onCommit={(v) => void store.applyStyle(path, { height: v }).then(afterDirectEdit)} />
          </>
        )}
      </div>
    </div>
  )
}

/** 'normal' → '' (unitless reset); '24' → '24' (unitless); '1.5' stays. */
function lineHeightOf(value: string | undefined): string {
  if (!value || value === 'normal') return ''
  const n = parseFloat(value)
  return Number.isFinite(n) ? String(n) : ''
}

function innerOf(fileText: string, location: { inner: { start: number; end: number } | null }): string {
  if (!location.inner) return ''
  return fileText.slice(location.inner.start, location.inner.end)
}

function ActionIcon(props: {
  title: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span
      title={props.title}
      onClick={props.disabled ? undefined : props.onClick}
      style={{
        width: 22,
        height: 22,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        flexShrink: 0,
        cursor: props.disabled ? 'default' : 'pointer',
        color: props.disabled ? '#ccc' : props.danger ? '#ff4d4f' : '#666',
        background: props.danger ? '#fff1f0' : 'transparent',
        border: '1px solid #e8e8e8',
      }}
    >
      {props.children}
    </span>
  )
}
