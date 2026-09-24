// PLAN-browser-snapshot-ai — the pure-logic half. The real-Chromium semantics
// (AI tree shape, ref persistence, content-swap interception, diff in action)
// belong to scripts/probe-browser-snapshot-ai.mjs; this file pins what vitest
// CAN see: selector shapes, tree rendering + trimming, diff entries/rendering,
// and the fast-fail wiring of runPlaywrightOp against a fake page.

import { describe, expect, it } from 'vitest'
import { pmRefSelector, isPmRefSelector, pmRefNumberOf, PM_REF_RECOVERY_HINT } from '../src/shared/browser-client/pm-refs'
import { renderAriaTree, MAX_REF_NODES, type AriaNode } from '../src/shared/browser-client/snapshot-render'
import { diffTrees, renderDiff } from '../src/shared/browser-client/snapshot-diff'
import { runPlaywrightOp } from '../src/main/browser/PlaywrightCommands'
import { playwrightSugar } from '../src/shared/browser-client/playwright-sugar'

describe('pm-refs — the aria-ref selector shape', () => {
  it('builds the bare engine selector and recognizes nothing else', () => {
    expect(pmRefSelector(3)).toBe('aria-ref=e3')
    expect(isPmRefSelector('aria-ref=e12')).toBe(true)
    expect(isPmRefSelector('[aria-ref="e12"]')).toBe(false) // CSS spelling does NOT resolve (measured)
    expect(isPmRefSelector('aria-ref=ex')).toBe(false)
    expect(isPmRefSelector('button')).toBe(false)
    expect(pmRefNumberOf('aria-ref=e12')).toBe('12')
    expect(pmRefNumberOf('aria-ref=e')).toBeNull()
  })

  it('the sugar ref() normalizes to the wire selector', () => {
    const loc = playwrightSugar.ref(3)
    expect(loc.selector).toBe('aria-ref=e3')
  })

  it('the recovery hint names the new numbering', () => {
    expect(PM_REF_RECOVERY_HINT).toContain('[ref=eN]')
  })
})

describe('renderAriaTree — trimming and shape', () => {
  const tree: AriaNode[] = [
    { role: 'document', ref: 'e1', children: [{ role: 'button', name: '登录', ref: 'e3' }, { role: 'textbox', name: '  spaced   name  ', ref: 'e4' }] },
  ]

  it('renders playwright-aligned YAML with refs', () => {
    const text = renderAriaTree(tree)
    expect(text).toContain('- document [ref=e1]')
    expect(text).toContain('  - button "登录" [ref=e3]')
    expect(text).toContain('- textbox "spaced name" [ref=e4]') // whitespace folded
  })

  it('names trim at 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const text = renderAriaTree([{ role: 'button', name: long, ref: 'e9' }])
    expect(text).toContain(`"${'x'.repeat(80)}…"`)
    expect(text).not.toContain('x'.repeat(90))
  })

  it('caps ref-bearing nodes at MAX and SAYS SO (the 说不截 contract)', () => {
    const big: AriaNode[] = Array.from({ length: MAX_REF_NODES + 20 }, (_, i) => ({ role: 'button', name: `b${i}`, ref: `e${i + 1}` }))
    const text = renderAriaTree(big)
    expect(text).toContain(`[ref=e${MAX_REF_NODES}]`)
    expect(text).not.toContain(`[ref=e${MAX_REF_NODES + 1}]`)
    expect(text).toContain('仅渲染前')
    // A tree under the cap says nothing about truncation
    const small = renderAriaTree(tree)
    expect(small).not.toContain('仅渲染前')
  })
})

describe('diffTrees + renderDiff — the three kinds', () => {
  const prev: AriaNode[] = [
    { role: 'main', ref: 'e1', children: [
      { role: 'button', name: '登录', ref: 'e5' },
      { role: 'link', name: '帮助', ref: 'e6' },
    ] },
  ]
  const next: AriaNode[] = [
    { role: 'main', ref: 'e1', children: [
      { role: 'button', name: '注册', ref: 'e5' }, // name swap → ~
      { role: 'textbox', name: '用户名', ref: 'e9' }, // new → +
      // e6 gone → -
    ] },
  ]

  it('classifies ~, +, - and counts the unchanged', () => {
    const d = diffTrees(prev, next)
    expect(d.unchanged).toBe(1) // e1
    const kinds = d.entries.map((e) => `${e.kind}:${e.ref}`)
    expect(kinds).toContain('~:e5')
    expect(kinds).toContain('+:e9')
    expect(kinds).toContain('-:e6')
    const swapped = d.entries.find((e) => e.ref === 'e5')!
    expect(swapped.oldName).toBe('登录')
  })

  it('the ancestor chain names the region (位置：e1)', () => {
    const d = diffTrees(prev, next)
    expect(d.entries.find((e) => e.ref === 'e5')!.path).toEqual(['e1'])
  })

  it('an empty diff renders the dead-link proof line', () => {
    const text = renderDiff(diffTrees(prev, prev))
    expect(text).toContain('无变化')
    expect(text).toContain('domSnapshot({ full: true })')
  })

  it('the diff block leads, collapses unchanged material and names the escape hatch', () => {
    const text = renderDiff(diffTrees(prev, next))
    expect(text).toContain('── 与上次快照的差异（3 处变化，其余 1 个元素未变）──')
    expect(text).toContain('~ [ref=e5] button "注册"（原 "登录"）')
    expect(text).toContain('+ [ref=e9] textbox "用户名"（新增）')
    expect(text).toContain('- [ref=e6] link "帮助"（已消失）')
    expect(text).toContain('位置：e1')
    expect(text.indexOf('差异（')).toBeLessThan(text.indexOf('位置：'))
  })

  it('refless structural drift is NOT a change (wrappers ride their ref ancestor)', () => {
    const a: AriaNode[] = [{ role: 'generic', children: [{ role: 'button', name: 'ok', ref: 'e2' }] }]
    const b: AriaNode[] = [{ role: 'generic', children: [{ role: 'generic', children: [{ role: 'button', name: 'ok', ref: 'e2' }] }] }]
    const d = diffTrees(a, b)
    expect(d.entries).toHaveLength(0)
  })
})

describe('runPlaywrightOp — the ref fast-fail (fake page)', () => {
  function fakePage(ops: { count?: number; probe?: unknown }) {
    let locatorCalls = 0
    const makeLocator = () => ({
      count: async () => ops.count ?? 1,
      evaluate: async () => ops.probe,
      click: async () => 'clicked',
    })
    return {
      locator: (sel: string) => {
        locatorCalls++
        return makeLocator()
      },
    } as never as Parameters<typeof runPlaywrightOp>[0]
  }

  it('fails a dead ref immediately with the upgrade hint, never reaching the op', async () => {
    const page = fakePage({ count: 0 })
    await expect(runPlaywrightOp(page, { selector: 'aria-ref=e404', op: 'click' })).rejects.toThrow(/编号体系已升级/)
  })

  it('a live ref with a role swap is rejected before the op (the reused-node trap)', async () => {
    const page = fakePage({ count: 1, probe: { role: 'textbox', name: '搜索', textHead: '搜索', tag: 'input' } })
    const tree: AriaNode[] = [{ role: 'button', name: '登录', ref: 'e3' }]
    await expect(runPlaywrightOp(page, { selector: 'aria-ref=e3', op: 'click' }, tree)).rejects.toThrow(/现指向 textbox 元素（快照时是 button）/)
  })

  it('a live ref matching the tree entry runs the op; a missing tree entry degrades to count', async () => {
    const page = fakePage({ count: 1, probe: { role: 'button', name: '登录', textHead: '登录', tag: 'button' } })
    const tree: AriaNode[] = [{ role: 'button', name: '登录', ref: 'e3' }]
    await expect(runPlaywrightOp(page, { selector: 'aria-ref=e3', op: 'click' }, tree)).resolves.toBe('clicked')
    const noTree = fakePage({ count: 1 })
    await expect(runPlaywrightOp(noTree, { selector: 'aria-ref=e3', op: 'click' })).resolves.toBe('clicked')
  })

  it('a non-ref selector skips the whole verify', async () => {
    const page = fakePage({ count: 0 }) // count 0 would fail a ref — plain selectors never check
    await expect(runPlaywrightOp(page, { selector: 'button.submit', op: 'click' })).resolves.toBe('clicked')
  })
})
