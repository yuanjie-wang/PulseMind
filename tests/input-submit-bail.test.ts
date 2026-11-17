// ── Submit bail keeps the draft (B3.1: 提交被拒时保草稿) ──
// The React layer cannot be mounted (vitest is node-env — the house style, see
// tests/staged-queue-wiring.test.ts), so the contract is asserted as a source
// scan. The rule it guards: a send that comes back `{ ok: false }` must NOT
// reach clear(), because `outgoing` carries selectedFiles (real File objects)
// and quotes that cannot be rebuilt after the fact — keeping the draft IS the
// restore. Before this, every bail cleared the box and left the user with a
// toast and an empty composer.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const INPUT_AREA = read('src', 'renderer', 'src', 'components', 'chat', 'InputArea.tsx')
const CHAT_VIEW = read('src', 'renderer', 'src', 'components', 'layout', 'ChatView.tsx')
const CHAT_BODY = read('src', 'renderer', 'src', 'components', 'chat', 'ChatBody.tsx')

/** The guarded line, verbatim — both submit sites (plain submit + steer fallback). */
const BAIL = 'if (!didSend(await onSendMessage(outgoing))) return'

describe('InputArea: a refused send leaves the draft in the box', () => {
  it('gates the clear() at BOTH send sites on the ack', () => {
    // Two sites, not one: submit() and submitSteer()'s race fallback. A third
    // send path added later without the gate would not be caught here, but the
    // type chain below makes the ack impossible to ignore at both known sites.
    expect(INPUT_AREA.split(BAIL).length - 1).toBe(2)
  })

  it('never clears an outgoing message whose send was not acked', () => {
    // Regression guard: the pre-B3.1 shape was `onSendMessage(outgoing)` on one
    // line and an unconditional `clear()` on the next. That must not come back.
    expect(INPUT_AREA).not.toMatch(/onSendMessage\(outgoing\)\n\s+clear\(\)/)
    // In the surviving shape the clear follows the bail, i.e. is reachable only
    // when the send WAS acked.
    for (const at of [INPUT_AREA.indexOf(BAIL), INPUT_AREA.indexOf(BAIL, INPUT_AREA.indexOf(BAIL) + 1)]) {
      expect(at).toBeGreaterThan(-1)
      const after = INPUT_AREA.slice(at + BAIL.length, at + BAIL.length + 40)
      expect(after).toContain('clear()')
    }
  })

  it('treats a void ack as "the host does not answer" — old behaviour, no draft kept', () => {
    // FormAssistColumn and friends hand over `(text) => void`; they have no
    // reasonCode to give back, so an undefined ack must not freeze the composer.
    expect(INPUT_AREA).toContain('const didSend = (ack: void | SendAck): boolean => ack == null || ack.ok')
  })

  it('declares the ack through all three layers so the plumbing cannot be dropped silently', () => {
    const SIGNATURE = 'onSendMessage: (content: string) => void | Promise<SendAck>'
    expect(INPUT_AREA).toContain(SIGNATURE)
    expect(CHAT_BODY).toContain(SIGNATURE)
    expect(CHAT_VIEW).toContain(SIGNATURE)
    // ChatView's pin wrapper must FORWARD the ack, not swallow it: it is the
    // only hop between App's handleRequest and InputArea's gate.
    expect(CHAT_VIEW).toContain('return onSendMessage(content)')
  })

  it('keeps submit async — the ack is only knowable after the await', () => {
    expect(INPUT_AREA).toContain('const submit = async (raw: string): Promise<void> => {')
  })
})
