import { describe, it, expect } from 'vitest'
import { runBrowserCode } from '../src/main/browser/kernel'
import { browserOk } from '../src/shared/browser-client/protocol'

const execute = async () => browserOk()

describe('runBrowserCode', () => {
  it('appends the timer hint when code reaches for setTimeout', async () => {
    const out = await runBrowserCode({ code: 'await new Promise((r) => setTimeout(r, 10))' }, execute)
    expect(out.result).toBe('null')
    expect(out.error).toContain('setTimeout is not defined')
    expect(out.error).toContain('await tab.waitForTimeout(ms)')
  })

  it('leaves unrelated reference errors untouched', async () => {
    const out = await runBrowserCode({ code: 'return undefinedVariable' }, execute)
    expect(out.error).toBe('ReferenceError: undefinedVariable is not defined')
  })

  it('returns the serialized value and console output on success', async () => {
    const out = await runBrowserCode({ code: "console.log('hi'); return { ok: 42 }" }, execute)
    expect(out.error).toBeUndefined()
    expect(out.result).toContain('42')
    expect(out.console).toEqual(['hi'])
  })
})
