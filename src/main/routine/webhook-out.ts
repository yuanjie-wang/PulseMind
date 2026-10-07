// ── Settlement webhook (PLAN-routine-triggers M1) ──
// The outbound half of the trigger feature: a settled routine run POSTs a
// JSON summary to the user-configured endpoint (ntfy, a home gateway, any
// receiver). Desktop notifications cover the person at the machine; this
// covers the person who is not — which is exactly when an unattended run
// matters.
//
// Discipline:
//  - FIRE-AND-FORGET: a slow or dead endpoint must never hold or fail the
//    settlement. Retries happen in the background, failures only log.
//  - PAYLOAD IS IDS, NOT CONTENT: no transcript body, no prompt, no file
//    paths from the run — the endpoint is usually a third party. The run's
//    transcript stays in the local DB, reachable by conversationId.
//  - The secret supports ${ENV} placeholders (same convention as provider
//    keys), resolved at send time — never rewritten on save.

import { createHmac } from 'node:crypto'
import { settingsStore } from '../storage/settings-store'
import { resolveEnvVarsInString } from '../../shared/env'

export interface RoutineSettlementEvent {
  event: 'routine.settled'
  routineId: string
  runId: string
  conversationId: string
  /** 'partial' = a batch parent run with mixed row outcomes — the desktop
   *  notification says 部分完成, so the webhook must not call it 'failed'
   *  (review_20261007 中4: 99/100 成功的批量跑给离机接收方推了 failed)。
   *  `error` carries the aggregated counts line for the receiver to read. */
  status: 'success' | 'partial' | 'failed'
  error?: string
  /** D13 auto-handled calls the user never saw: approvals rejected, questions skipped. */
  skipped: { approvals: number; questions: number }
  finishedAt: string
}

/** `t=<unix秒>,v1=<hex(hmacSHA256(secret, t + '.' + body))>` — timestamped so
 *  a receiver can refuse stale replays (5-minute window is the convention). */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

const TIMEOUT_MS = 10_000
const ATTEMPTS = 3

export async function postSettlementEvent(payload: RoutineSettlementEvent): Promise<void> {
  let url = ''
  let secret = ''
  try {
    const settings = await settingsStore.get()
    const n = settings.notifications
    if (!n?.webhookUrl || n.onSettled === false) return
    url = resolveEnvVarsInString(n.webhookUrl).trim()
    secret = resolveEnvVarsInString(n.webhookSecret ?? '')
  } catch (err) {
    console.warn('[routine-webhook] settings read failed:', err instanceof Error ? err.message : err)
    return
  }
  if (!/^https?:\/\//i.test(url)) return

  const body = JSON.stringify({ ...payload, error: payload.error?.slice(0, 500) })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) {
    const t = Math.floor(Date.now() / 1000)
    headers['x-pulsemind-signature'] = `t=${t},v1=${signPayload(secret, t, body)}`
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const net = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
      // 4xx (except 429) is a receiver-side misconfig — backing off cannot fix it.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return
      console.warn(`[routine-webhook] attempt ${attempt}/${ATTEMPTS}: HTTP ${res.status}`)
    } catch (err) {
      console.warn(`[routine-webhook] attempt ${attempt}/${ATTEMPTS}:`, err instanceof Error ? err.message : err)
    } finally {
      clearTimeout(net)
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)))
  }
}
