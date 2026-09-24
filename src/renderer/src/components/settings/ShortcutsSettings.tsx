// ── Keyboard shortcuts settings section ──
// 设置 → 快捷键: the 8 app-level actions are rebindable here (press-to-record,
// conflicts and Electron-role keys rejected), everything else is a read-only
// reference because those combos live inside feature surfaces (composer) and
// have no central registry. Saving rides SETTINGS_SET; main
// rebuilds the menu + fallback from shared/shortcuts.ts, so a rebind lands
// immediately — including on the command palette's hints.
import React, { useEffect, useState } from 'react'
import { Button, Drawer, Typography } from 'antd'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import {
  SHORTCUT_ACTION_IDS,
  effectiveAccelerators,
  formatAccelerator,
  validateBinding,
  type ShortcutActionId,
} from '../../../../shared/shortcuts'

const { Text } = Typography

interface ShortcutsSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

/** keydown → Electron accelerator string, or null to keep waiting. Modifier
 *  chords alone never complete a capture; letters serialize uppercase and
 *  '+' becomes `Plus` because a bare '+' is the accelerator separator. */
function eventToAccelerator(e: KeyboardEvent, isMac: boolean): string | null {
  const key = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null
  const mods: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('CmdOrCtrl')
  else if (isMac && e.ctrlKey) mods.push('Ctrl')
  else if (!isMac && e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let keyName: string | null = null
  if (/^[a-zA-Z]$/.test(key)) keyName = key.toUpperCase()
  else if (/^[0-9]$/.test(key) || /^F\d{1,2}$/.test(key)) keyName = key
  else if (key === '+') keyName = 'Plus'
  else if (key === ' ') keyName = 'Space'
  else if (key.length === 1) keyName = key
  if (!keyName || !mods.length) return null
  return [...mods, keyName].join('+')
}

function ShortcutsSettings({ open, onClose, inline }: ShortcutsSettingsProps): React.ReactElement {
  const { settings, loading, saving, saveSettings } = useSettings()
  const { t } = useTranslation()
  const [recording, setRecording] = useState<ShortcutActionId | null>(null)
  const isMac = /mac/i.test(navigator.platform)
  const current = effectiveAccelerators(settings.shortcuts)
  const disabled = loading || saving

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escape always cancels — a shortcut on Esc itself is not offerable
      // (it is every surface's "dismiss" key).
      if (e.key === 'Escape') {
        e.preventDefault()
        setRecording(null)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const accelerator = eventToAccelerator(e, isMac)
      if (!accelerator) return
      const validation = validateBinding(recording, accelerator, current)
      if (!validation.ok) {
        const actionLabel = validation.conflictWith ? t(`shortcutSettings.action.${validation.conflictWith}`) : ''
        notify.error(t(`shortcutSettings.problem.${validation.problem}`, { action: actionLabel }))
        setRecording(null)
        return
      }
      const overrides = { ...(settings.shortcuts ?? {}), [recording]: accelerator }
      void saveSettings({ ...settings, shortcuts: overrides }).then(() => {
        notify.success(t('shortcutSettings.rebound', { key: formatAccelerator(accelerator, isMac) }))
      })
      setRecording(null)
    }
    // Capture phase: the composer handler must not see a chord
    // the user is trying to record.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, current, settings, saveSettings, isMac, t])

  const handleReset = (action: ShortcutActionId): void => {
    const overrides = { ...(settings.shortcuts ?? {}) }
    delete overrides[action]
    void saveSettings({ ...settings, shortcuts: overrides })
  }

  const actionRow = (action: ShortcutActionId): React.ReactElement => {
    const overridden = settings.shortcuts?.[action] !== undefined
    return (
      <div
        key={action}
        data-shortcut-row={action}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}
      >
        <Text strong style={{ fontSize: 13 }}>
          {t(`shortcutSettings.action.${action}`)}
        </Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {recording === action ? (
            <Text type="warning" style={{ fontSize: 12 }} data-shortcut-recording={action}>
              {t('shortcutSettings.pressHint')}
            </Text>
          ) : (
            <Text code data-shortcut-key={action} style={{ fontSize: 15 }}>
              {formatAccelerator(current[action], isMac)}
            </Text>
          )}
          <Button size="small" disabled={disabled} data-shortcut-edit={action} onClick={() => setRecording(action)}>
            {t('shortcutSettings.edit')}
          </Button>
          {overridden && (
            <Button size="small" disabled={disabled} onClick={() => handleReset(action)}>
              {t('shortcutSettings.reset')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const fixedRow = (label: string, keys: string): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
      <Text style={{ fontSize: 13 }}>{label}</Text>
      <Text code style={{ fontSize: 14 }}>
        {keys}
      </Text>
    </div>
  )

  const body = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>
        {t('shortcutSettings.title')}
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 12 }}>
            {t('shortcutSettings.appSection')}
          </Text>
          {SHORTCUT_ACTION_IDS.map(actionRow)}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('shortcutSettings.appSectionHelp')}
          </Text>
        </section>
        <section>
          <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 12 }}>
            {t('shortcutSettings.fixedSection')}
          </Text>
          <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>
            {t('shortcutSettings.fixedComposer')}
          </Text>
          {fixedRow(t('shortcutSettings.fixedSend'), isMac ? '↩' : 'Enter')}
          {fixedRow(t('shortcutSettings.fixedNewline'), isMac ? '⇧ ↩' : 'Shift+Enter')}
          {fixedRow(t('shortcutSettings.fixedHistory'), '↑ / ↓')}
          <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 8, marginTop: 12 }}>
            {t('shortcutSettings.fixedGeneral')}
          </Text>
          {fixedRow(t('shortcutSettings.fixedDismiss'), 'Esc')}
        </section>
      </div>
    </>
  )

  if (inline) {
    return (
      <div style={{ height: '100%', overflow: 'auto' }}>
        {body}
      </div>
    )
  }

  return (
    <>
      <Drawer title={t('shortcutSettings.title')} open={open} onClose={onClose} size={480}>
        {body}
      </Drawer>
    </>
  )
}

export default ShortcutsSettings
