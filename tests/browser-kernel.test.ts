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

// ── PLAN-tool-issues A4-r（2026-10-28）：空 code = 活能力清单 ──
// 「靠报错学 API」每次试错都是一整次往返；错误菜单是现成的从活对象派生的
// 机制，但只在犯错后出现。空 code 现在主动回清单——从真实 facade 实例遍历
// 而来（与 member-guard 同一 derive 规则），新成员自动出现、不可能像手写
// 文档那样漂移（webfetch 的教训）。
describe('empty code → live capability manifest (A4-r)', () => {
  it('empty and whitespace-only code return the manifest without running anything', async () => {
    for (const code of ['', '   ']) {
      const out = await runBrowserCode({ code }, execute)
      expect(out.error).toBeUndefined()
      expect(out.images).toEqual([])
      expect(out.result).toContain('live capability manifest')
      expect(out.result).toContain('emitImage')
      expect(out.result).toContain('waitForTimeout')
    }
  })

  it('the manifest is DERIVED from the facade: every real member of agent appears', async () => {
    const { createBrowserFacade } = await import('../src/shared/browser-client/facade')
    const facade = createBrowserFacade({ execute, emitImage: () => {} })
    const out = await runBrowserCode({ code: '' }, execute)
    // Top level: playwright / documentation / browsers — read off the object.
    for (const key of Object.keys(facade.agent)) {
      expect(out.result).toContain(`agent.${key}`)
    }
    // Two named members that historically got guessed wrong.
    expect(out.result).toContain('agent.browsers.tabs')
    expect(out.result).toContain('agent.browsers.open()')
    // Per-backend detail stays in documentation(), pointed at by the tail.
    expect(out.result).toContain('agent.documentation()')
  })

  it('the probe facade never executes a command', async () => {
    const out = await runBrowserCode({ code: '' }, async () => { throw new Error('MUST NOT BE CALLED') })
    expect(out.error).toBeUndefined()
    expect(out.result).toContain('live capability manifest')
  })
})

describe('A4-r wiring (source scans)', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf-8')

  it('execBrowser no longer rejects empty code', () => {
    const src = read('src/renderer/src/agent/tool-executors.ts')
    const fn = src.slice(src.indexOf('async execBrowser('), src.indexOf('async execWebFetch('))
    expect(fn).not.toContain('code is required')
    expect(fn).toContain('Empty code is legal')
  })

  it('schema advertises the self-check and no longer requires code', async () => {
    const { BUILT_IN_TOOLS } = await import('../src/renderer/src/tools/built-in-tools')
    const def = BUILT_IN_TOOLS.find((d) => d.name === 'browser')
    expect(def.description).toContain('omit `code` to dump the live capability manifest')
    expect(def.input_schema.required ?? []).not.toContain('code')
    expect(def.input_schema.properties.code.description).toContain('capability manifest')
  })

  it('the manual teaches the self-check as step 0', () => {
    expect(read('src/renderer/src/skills/built-in/browser.ts')).toContain('dumps the live capability manifest')
  })
})
