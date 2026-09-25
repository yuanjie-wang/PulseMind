// PLAN-browser-snapshot-ai — the pure-logic half. The real-Chromium semantics
// (AI tree shape, ref persistence, content-swap interception, diff in action)
// belong to scripts/probe-browser-snapshot-ai.mjs; this file pins what vitest
// CAN see: selector shapes, tree rendering + trimming, diff entries/rendering,
// and the fast-fail wiring of runPlaywrightOp against a fake page.

import { describe, expect, it } from 'vitest'
import { pmRefSelector, isRefLiteral, resolveSelectorArg, isPmRefSelector, pmRefOf, PM_REF_RECOVERY_HINT } from '../src/shared/browser-client/pm-refs'
import { renderAriaTree, MAX_REF_NODES, type AriaNode } from '../src/shared/browser-client/snapshot-render'
import { diffTrees, renderDiff } from '../src/shared/browser-client/snapshot-diff'
import { runPlaywrightOp } from '../src/main/browser/PlaywrightCommands'
import { sameDocumentUrl } from '../src/main/browser/snapshot-refs'
import { playwrightSugar } from '../src/shared/browser-client/playwright-sugar'

describe('pm-refs — the aria-ref selector shape', () => {
  it('builds the bare engine selector and recognizes nothing else', () => {
    expect(pmRefSelector(3)).toBe('aria-ref=e3')
    expect(pmRefSelector('74')).toBe('aria-ref=e74') // a digit string is still a bare number
    expect(isPmRefSelector('aria-ref=e12')).toBe(true)
    expect(isPmRefSelector('[aria-ref="e12"]')).toBe(false) // CSS spelling does NOT resolve (measured)
    expect(isPmRefSelector('aria-ref=ex')).toBe(false)
    expect(isPmRefSelector('button')).toBe(false)
    expect(pmRefOf('aria-ref=e12')).toBe('e12')
    expect(pmRefOf('aria-ref=e')).toBeNull()
  })

  // Measured on a webmail login flow (conv_20260925230016): the snapshot
  // printed [ref=e1] on the login page and [ref=f7e1] after the SPA had been
  // walked a few navigations — the frame id is a persistent counter that grows,
  // so the prefix reaches even the MAIN document. `tab.playwright('f7e74')`
  // then went out as a raw CSS selector and burned an 8s locator timeout,
  // while `tab.playwright(74)` resolved e74 in the wrong frame (count 0 →
  // 编号不存在). No API path produced aria-ref=f7e74 at all.
  it('a frame-prefixed ref is one token: selector, recognition and error name', () => {
    expect(pmRefSelector('f7e74')).toBe('aria-ref=f7e74')
    expect(pmRefSelector(74)).toBe('aria-ref=e74')
    expect(isPmRefSelector('aria-ref=f7e74')).toBe(true)
    expect(pmRefOf('aria-ref=f7e74')).toBe('f7e74')
    expect(isRefLiteral('f7e74')).toBe(true)
    expect(isRefLiteral('e74')).toBe(true)
    expect(isRefLiteral('74')).toBe(false) // a bare number is not the token form
    expect(isRefLiteral('internal:role=button')).toBe(false)
  })

  it('a bare ref literal passed as a string becomes the selector; anything else passes through', () => {
    expect(resolveSelectorArg('f7e74')).toBe('aria-ref=f7e74')
    expect(resolveSelectorArg('e12')).toBe('aria-ref=e12')
    // CSS/XPath/role chains are already selectors and must never be re-prefixed
    expect(resolveSelectorArg('button.submit')).toBe('button.submit')
    expect(resolveSelectorArg('internal:role=button')).toBe('internal:role=button')
  })

  it('the sugar ref() accepts the printed token as-is', () => {
    expect(playwrightSugar.ref(3).selector).toBe('aria-ref=e3')
    expect(playwrightSugar.ref('f7e74').selector).toBe('aria-ref=f7e74')
  })

  it('the recovery hint names the new numbering AND the frame-prefix rule', () => {
    expect(PM_REF_RECOVERY_HINT).toContain('[ref=eN]')
    expect(PM_REF_RECOVERY_HINT).toContain('f7e74')
    expect(PM_REF_RECOVERY_HINT).toContain('原样')
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

  it('renders the actionable state decorations (checked/disabled/selected/level/url)', () => {
    const text = renderAriaTree([
      { role: 'checkbox', checked: true, ref: 'e1' },
      { role: 'checkbox', checked: false, ref: 'e2' }, // OFF marks nothing, like Playwright's own YAML
      { role: 'checkbox', checked: 'mixed', ref: 'e3' },
      { role: 'button', name: '禁用', disabled: true, ref: 'e4' },
      { role: 'option', name: '甲', selected: true, ref: 'e5' },
      { role: 'heading', name: '标题', level: 1, ref: 'e6' },
      { role: 'link', name: '文档', url: '/docs', ref: 'e7' },
    ])
    expect(text).toContain('- checkbox [ref=e1] [checked]')
    expect(text).toContain('- checkbox [ref=e2]')
    expect(text).toContain('- checkbox [ref=e3] [mixed]')
    expect(text).toContain('- button "禁用" [ref=e4] [disabled]')
    expect(text).toContain('- option "甲" [ref=e5] [selected]')
    expect(text).toContain('- heading "标题" [ref=e6] [level=1]')
    expect(text).toContain('- link "文档" [ref=e7] [url=/docs]')
  })

  it('truncates a long url decoration and keeps the addressability keys first', () => {
    const text = renderAriaTree([{ role: 'link', name: '长链', url: `/${'x'.repeat(60)}`, ref: 'e1' }])
    expect(text).toContain(`[url=/${'x'.repeat(39)}…]`) // URL_MAX counts the leading slash
    expect(text).not.toContain('x'.repeat(40))
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

  it('a check toggle is a ~ even though role and name stand still', () => {
    const before: AriaNode[] = [{ role: 'checkbox', name: '记住我', ref: 'e5' }]
    const after: AriaNode[] = [{ role: 'checkbox', name: '记住我', checked: true, ref: 'e5' }]
    const d = diffTrees(before, after)
    expect(d.entries).toHaveLength(1)
    expect(d.entries[0]!.kind).toBe('~')
    const text = renderDiff(d)
    expect(text).toContain('~ [ref=e5] checkbox "记住我" [checked]（原 无）')
  })

  it('a disable between snapshots is a ~; a name change hides the redundant old-state suffix', () => {
    const before: AriaNode[] = [{ role: 'button', name: '提交', ref: 'e5' }]
    const after: AriaNode[] = [{ role: 'button', name: '提交', disabled: true, ref: 'e5' }]
    expect(renderDiff(diffTrees(before, after))).toContain('~ [ref=e5] button "提交" [disabled]（原 无）')
    // name + state both moved → the (原 "name") form wins, one suffix only
    const renamed: AriaNode[] = [{ role: 'button', name: '取消', disabled: true, ref: 'e5' }]
    const text = renderDiff(diffTrees(before, renamed))
    expect(text).toContain('~ [ref=e5] button "取消" [disabled]（原 "提交"）')
    expect(text).not.toContain('原 无')
    // state back to plain renders no decorations at all
    const restored: AriaNode[] = [{ role: 'button', name: '取消', ref: 'e5' }]
    expect(renderDiff(diffTrees(renamed, restored))).toContain('~ [ref=e5] button "取消"（原 [disabled]）')
  })
})

describe('runPlaywrightOp — the ref fast-fail (fake page)', () => {
  function fakePage(ops: { count?: number; probe?: unknown }) {
    let _locatorCalls = 0
    const makeLocator = () => ({
      count: async () => ops.count ?? 1,
      evaluate: async () => ops.probe,
      click: async () => 'clicked',
    })
    return {
      locator: (_sel: string) => {
        _locatorCalls++
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

  // The frame prefix is part of the ADDRESS: the tree is keyed on the exact
  // token the snapshot printed, and the error must name that token back.
  it('a frame-prefixed ref fails, verifies and reports WITH its prefix', async () => {
    const gone = fakePage({ count: 0 })
    const err = await runPlaywrightOp(gone, { selector: 'aria-ref=f7e74', op: 'click' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('编号 [ref=f7e74] 不存在或已失效')
    expect((err as Error).message).toContain('只传数字会丢掉帧前缀') // names the exact mistake observed

    const page = fakePage({ count: 1, probe: { role: 'button', name: '登录', textHead: '登录', tag: 'button' } })
    const tree: AriaNode[] = [{ role: 'button', name: '登录', ref: 'f7e74' }]
    await expect(runPlaywrightOp(page, { selector: 'aria-ref=f7e74', op: 'click' }, tree)).resolves.toBe('clicked')
    // ...and the swap check fires on the prefixed entry too (dropping the prefix
    // would find nothing and silently fall back to count-only verification)
    const swapped = fakePage({ count: 1, probe: { role: 'textbox', name: '搜索', textHead: '搜索', tag: 'input' } })
    await expect(runPlaywrightOp(swapped, { selector: 'aria-ref=f7e74', op: 'click' }, tree)).rejects.toThrow(/编号 \[ref=f7e74\] 已失效/)
  })
})

describe('sameDocumentUrl — the hash-route diff gate', () => {
  it('diffs across an SPA fragment switch (the reset that forced full renders)', () => {
    expect(sameDocumentUrl('https://mail.example.com/#write', 'https://mail.example.com/#contacts')).toBe(true)
    expect(sameDocumentUrl('https://a.com/x#one', 'https://a.com/x#one')).toBe(true)
  })
  it('a real navigation still ends the diff', () => {
    expect(sameDocumentUrl('https://a.com/#write', 'https://b.com/#write')).toBe(false)
    expect(sameDocumentUrl('https://a.com/list', 'https://a.com/detail')).toBe(false)
    expect(sameDocumentUrl('https://a.com/list?page=1', 'https://a.com/list?page=2')).toBe(false) // query IS a new document
  })
  it('a trailing fragment never leaves a dangling candidate', () => {
    expect(sameDocumentUrl('https://a.com/x', 'https://a.com/x#')).toBe(true)
    expect(sameDocumentUrl('https://a.com/x#y', 'https://a.com/x')).toBe(true)
  })
})
