// ── Run-now parameter dialog (例行任务 · 立即运行) ──
// The one entry point for starting a routine by hand, shared by the card grid,
// the run workspace and the welcome page. A routine WITHOUT params runs
// directly; one WITH params opens this dialog first — prefilled with the
// defaults, required fields enforced before 运行 lights up. Scheduled runs are
// untouched: they never had a user to ask and always run the defaults.
//
// The hook (useRoutineRunNow) owns the decision and the IPC so no caller can
// bypass the dialog by calling routineRun directly; the modal is just the form.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Input, Modal } from 'antd'
import { notify } from '../../utils/notify'
import { useTranslation } from '../../i18n/useTranslation'
import { missingRequiredParamKeys } from '../../../../shared/routine/params'
import type { Routine } from '../../../../shared/types/routine'

export interface RoutineRunModalProps {
  /** The routine waiting for its parameter values (null = nothing pending). */
  routine: Routine | null
  open: boolean
  onClose: () => void
  /** Called with the collected values once the user confirms. */
  onRun: (routine: Routine, values: Record<string, string>) => void
}

export function RoutineRunModal({ routine, open, onClose, onRun }: RoutineRunModalProps): React.ReactElement {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})

  // Repopulate from the defaults when the dialog finishes opening — an event,
  // not a mount effect, so reopening for another routine never shows the last
  // one's half-typed values.
  const afterOpenChange = (next: boolean): void => {
    if (!next || !routine) return
    const initial: Record<string, string> = {}
    for (const p of routine.params ?? []) initial[p.key] = p.default ?? ''
    setValues(initial)
  }

  const missing = routine ? missingRequiredParamKeys(routine, values) : []

  return (
    <Modal
      title={routine ? t('routine.runModalTitle', { name: routine.name }) : ''}
      open={open}
      onCancel={onClose}
      onOk={() => routine && onRun(routine, values)}
      afterOpenChange={afterOpenChange}
      width={440}
      cancelText="取消"
      okText="运行"
      okButtonProps={{ disabled: missing.length > 0 }}
      focusable={{ focusTriggerAfterClose: false }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        <div style={{ fontSize: 12, color: '#999' }}>{t('routine.runModalHint')}</div>
        {/* The configured 单次超时 now bounds a single run too (it used to be
            batch-only), so say so where the run is started — a task whose
            ceiling is 60 minutes should not read as the built-in 15. */}
        {routine?.batch?.timeoutMinutes != null && (
          <div style={{ fontSize: 12, color: '#999' }} data-run-timeout>
            {t('routine.runModalTimeout', { minutes: routine.batch.timeoutMinutes })}
          </div>
        )}
        {(routine?.params ?? []).map((p) => {
          const value = values[p.key] ?? ''
          const blank = value.trim() === ''
          return (
            <div key={p.key}>
              <div style={{ marginBottom: 6, fontSize: 13 }}>
                {p.required && <span style={{ color: '#ff4d4f', marginRight: 2 }}>*</span>}
                {p.label || p.key}
              </div>
              <Input
                value={value}
                status={p.required && blank ? 'error' : undefined}
                onChange={(e) => setValues((prev) => ({ ...prev, [p.key]: e.target.value }))}
                placeholder={p.default ? t('routine.runModalDefaultPlaceholder', { value: p.default }) : t('routine.runModalOptionalPlaceholder')}
              />
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/** Shared 立即运行 entry: no params → run straight away; params → collect them
 *  in the dialog first. Owns the IPC call and both notifications so every
 *  surface behaves identically. */
export function useRoutineRunNow(onStarted?: (routine: Routine) => void): {
  runNow: (routine: Routine) => void
  modal: React.ReactElement
} {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Routine | null>(null)
  const [open, setOpen] = useState(false)
  // Latest-callback ref: callers pass inline arrows (navigation jumps); the
  // launch closure must not go stale between render and click.
  const onStartedRef = useRef(onStarted)
  useEffect(() => {
    onStartedRef.current = onStarted
  })

  const launch = useCallback(
    (routine: Routine, values?: Record<string, string>) => {
      void window.electronAPI
        .routineRun(routine.id, values)
        .then(() => {
          notify.success(t('routine.runStarted', { name: routine.name }))
          onStartedRef.current?.(routine)
        })
        .catch((err) => notify.error(err instanceof Error ? err.message : String(err)))
    },
    [t],
  )

  const runNow = useCallback(
    (routine: Routine) => {
      if ((routine.params?.length ?? 0) === 0) launch(routine)
      else {
        setPending(routine)
        setOpen(true)
      }
    },
    [launch],
  )

  const modal = (
    <RoutineRunModal
      routine={pending}
      open={open}
      onClose={() => setOpen(false)}
      onRun={(routine, values) => {
        setOpen(false)
        launch(routine, values)
      }}
    />
  )
  return { runNow, modal }
}
