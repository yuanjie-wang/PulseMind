/**
 * Terminal event isolation (PLAN-parallel-experts T7).
 *
 * The terminal bus broadcasts by channel — every engine subscribed during
 * another engine's process receives its output/exit events. Both consumers
 * therefore filter by `processId` themselves, and must handle the window
 * where a subscription exists but `executeCommand` has not returned a pid
 * yet: events in that window are parked by pid and delivered (only our own)
 * when `claim(pid)` runs. Park BEFORE subscribing is wrong and claim-before-
 * subscribe is wrong too — the pairing is: subscribe → executeCommand →
 * claim(pid), with the exit of a fast command possibly parked and delivered
 * by claim itself.
 */
import type { TerminalOutputEvent, TerminalExitEvent } from '../types/electron'
import type { PulseHost } from './host/types'

interface TerminalSpanHandlers {
  onOutput: (d: TerminalOutputEvent) => void
  onExit: (d: TerminalExitEvent) => void
  onError: (d: { processId: string; message: string }) => void
}

export interface TerminalSpan {
  /** Subscribe to the three terminal channels. Call BEFORE executeCommand —
   *  output earlier than the subscription would be lost to this consumer. */
  start(): void
  /** Bind to the pid executeCommand resolved with; plays this span's parked
   *  events in arrival order. Foreign parked events are dropped. */
  claim(pid: string): void
  /** Unsubscribe everything (idempotent; called from the existing cleanup paths). */
  stop(): void
}

export function beginTerminalSpan(host: PulseHost, handlers: TerminalSpanHandlers): TerminalSpan {
  let claimed: string | null = null
  let stopped = false
  const parked: Array<{ pid: string, play: () => void }> = []
  const unsubs: Array<() => void> = []

  const admit = (pid: string | undefined, play: () => void): void => {
    if (stopped) return
    if (claimed === null) { parked.push({ pid: pid ?? '', play }); return }
    if (pid !== claimed) return // someone else's process — not ours to consume
    play()
  }

  return {
    start() {
      unsubs.push(host.onTerminalOutput(d => admit(d.processId, () => handlers.onOutput(d))))
      unsubs.push(host.onTerminalExit(d => admit(d.processId, () => handlers.onExit(d))))
      unsubs.push(host.onTerminalError(d => admit(d.processId, () => handlers.onError(d))))
    },
    claim(pid: string) {
      claimed = pid
      const mine = parked.filter(e => e.pid === pid)
      parked.length = 0
      for (const e of mine) e.play()
    },
    stop() {
      stopped = true
      parked.length = 0
      unsubs.forEach(u => { try { u() } catch { /* already gone */ } })
      unsubs.length = 0
    },
  }
}
