import { chromium } from 'playwright-core'
import { takeDomSnapshot } from '../src/main/browser/snapshot-refs.ts'
import { runPlaywrightOp } from '../src/main/browser/PlaywrightCommands.ts'
import { MAX_REF_NODES, renderAriaTree } from '../src/shared/browser-client/snapshot-render.ts'
let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'assert'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'expected truthy') }


const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()

  // ── 1. Full shape: refs, roles, names, iframes ──
  await page.setContent(`
    <main><h1>示例页</h1>
      <button onclick="window.__clicked = (window.__clicked || 0) + 1">登录</button>
      <a href="#help">帮助</a>
      <iframe srcdoc="<button id='inner'>支付确认</button>"></iframe>
    </main>`)
  let snap = await takeDomSnapshot(page)
  check('全量快照：AI 树带 [ref=eN]（含 iframe 内容）', () => {
    ok(snap.text.includes('[ref=e'))
    ok(snap.text.includes('登录'))
    ok(snap.text.includes('支付确认'), 'iframe content is visible')
  })
  const forgedCount = await page.evaluate(() => document.querySelectorAll('[data-pm-ref]').length)
  check('全量快照不写页面（data-pm-ref 半边已删）', () => {
    eq(forgedCount, 0)
  })

  // ── 2. Ref persistence across snapshots ──
  const refOf = (label) => { const m = snap.tree.map ? JSON.stringify(snap.tree).match(new RegExp('"ref":"(e\\d+)","[^"]*"')) : null; return m?.[1] }
  const allRefs = (tree) => JSON.stringify(tree).match(/e\d+/g) ?? []
  const refs1 = allRefs(snap.tree)
  snap = await takeDomSnapshot(page, { url: page.url(), tree: snap.tree })
  check('连续快照编号持久（新快照不重置）', () => {
    const refs2 = allRefs(snap.tree)
    for (const r of refs1) ok(refs2.includes(r), `${r} survived`)
  })
  // full snapshot also keeps refs
  const fullSnap = await takeDomSnapshot(page, { url: page.url(), tree: snap.tree }, { full: true })
  check('{full:true} 全量直通且编号一致', () => {
    ok(fullSnap.text.length > snap.text.length || fullSnap.text.includes('页面全量'))
    for (const r of refs1) ok(allRefs(fullSnap.tree).includes(r))
  })

  // ── 3. Addressing + content-swap interception ──
  const btnRef = (function find(tree) {
    for (const n of tree) {
      if (n.role === 'button' && n.name === '登录') return n.ref
      const r = find(n.children ?? [])
      if (r) return r
    }
  })(snap.tree)
  ok(btnRef, 'button ref found')
  const before = await page.evaluate(() => window.__clicked || 0)
  await runPlaywrightOp(page, { selector: `aria-ref=${btnRef}`, op: 'click' }, snap.tree)
  const after = await page.evaluate(() => window.__clicked || 0)
  check('aria-ref 寻址 click 真实落地', () => {
    eq(after, before + 1)
  })

  // Framework swaps the node's content (kept position, new meaning):
  await page.evaluate(() => { const b = document.querySelector('main button'); b.textContent = '注册'; b.id = 'swapped' })
  let swapped = false
  try {
    await runPlaywrightOp(page, { selector: `aria-ref=${btnRef}`, op: 'click' }, snap.tree)
  } catch (e) {
    swapped = /已失效|现指向/.test(e.message)
  }
  check('内容置换被服务端树回查拦截（旧 ref 不再静默点错）', () => { ok(swapped) })

  // ── 4. Removed node fast-fails without the locator timeout ──
  await page.evaluate(() => document.querySelector('main a').remove())
  const aRef = (function find(tree) {
    for (const n of tree) {
      if (n.role === 'link') return n.ref
      const r = find(n.children ?? [])
      if (r) return r
    }
  })(snap.tree)
  const t0 = Date.now()
  let fastFail = false
  try {
    await runPlaywrightOp(page, { selector: `aria-ref=${aRef}`, op: 'click' }, snap.tree)
  } catch (e) {
    fastFail = /不存在或已失效/.test(e.message) && Date.now() - t0 < 3000
  }
  check('删节点 → 快失败（<3s，不烧 8s timeout）', () => { ok(fastFail) })

  // ── 5. Diff in action: three kinds, live ──
  await page.evaluate(() => {
    const b = document.querySelector('main button'); b.textContent = '注册'
    const a = document.createElement('a'); a.href = '#new'; a.textContent = '新增链接'; document.querySelector('main').appendChild(a)
  })
  const prev = { url: page.url(), tree: snap.tree }
  const diffSnap = await takeDomSnapshot(page, prev)
  check('默认 diff：变化一次性到位（实测：引擎对文本置换派发新 ref → 表现为 -旧/+新；同 ref 改名才是 ~，已由 vitest 钉死）', () => {
    ok(diffSnap.text.includes(`- [ref=${btnRef}] button "登录"（已消失）`), 'old identity gone')
    ok(diffSnap.text.includes('"注册"'), 'new label present')
    // The added link carries its href as a [url=…] decoration now (state keys
    // render in the diff too) — the regex allows for it.
    ok(/\+ \[ref=e\d+\] link "新增链接"( \[url=[^\]]*\])?（新增）/.test(diffSnap.text), 'added entry')
    ok(diffSnap.text.includes(`- [ref=${aRef}]`), 'removed entry')
    ok(diffSnap.text.includes('其余'), 'unchanged collapse line')
    ok(diffSnap.text.includes('{ full: true }'), 'escape hatch named')
  })

  // ── 6. Navigation resets to full ──
  const beforeNavUrl = page.url()
  await page.goto('data:text/html,<button>%E7%AC%AC%E4%BA%8C%E9%A1%B5</button>')
  const navSnap = await takeDomSnapshot(page, { url: beforeNavUrl, tree: diffSnap.tree })
  check('导航后 url 变化 → 全量（不是跨页 diff）', () => {
    ok(!navSnap.text.includes('与上次快照的差异（'), 'no diff after navigation')
    ok(navSnap.text.includes('- document [ref=e1]'), 'full render (mojibake-safe structural assert; data: URL decodes CJK as latin1)')
  })

  // ── 7. Trim: >MAX refs says so ──
  {
    let many = '<div>'
    for (let i = 0; i < MAX_REF_NODES + 5; i++) many += `<button>b${i}</button>`
    many += '</div>'
    await page.setContent(many)
    const big = await takeDomSnapshot(page)
    check('超上限显式截断声明（说不截契约）', () => {
      ok(big.text.includes('仅渲染前'))
    })
  }

  // ── 8. Page-forged attributes cannot hijack addressing ──
  // The engine's refs are assigned server-side; a page setting its OWN
  // aria-ref/data-pm-ref attributes changes nothing the toolchain reads.
  await page.setContent('<button onclick="void 0">真按钮</button><div aria-ref="e1" data-pm-ref="s1:abc:1" onclick="window.__hijacked = true">伪按钮</div>')
  const forged = await takeDomSnapshot(page)
  check('页面伪造 aria-ref/data-pm-ref 属性无法劫持寻址（引擎不读页面可见属性）', () => {
    // The snapshot's e1 is the engine's own assignment (document node), NOT
    // the decoy div the page tried to label e1.
    const realRef = (function find(tree) {
      for (const n of tree) {
        if (n.role === 'button') return n.ref
        const r = find(n.children ?? [])
        if (r) return r
      }
    })(forged.tree)
    ok(realRef, 'real button has an engine ref')
    ok(forged.text.includes('真按钮'))
  })
  {
    const realRef = (function find(tree) {
      for (const n of tree) {
        if (n.role === 'button') return n.ref
        const r = find(n.children ?? [])
        if (r) return r
      }
    })(forged.tree)
    await runPlaywrightOp(page, { selector: `aria-ref=${realRef}`, op: 'click' }, forged.tree)
    const hijacked = await page.evaluate(() => window.__hijacked === true)
    check('寻址引擎的 eN 命中真按钮，伪造属性上的自设 eN 未被触发', () => { ok(!hijacked) })
  }

  // ── 9. app-view backend regression: the same semantics over connectOverCDP ──
  // AppViewBackend drives the in-app pane over CDP, which is a DIFFERENT
  // transport from the managed launch above — PLAN §三 named this section and
  // §六 made it the risk gate, so it lives here, not in a manual step.
  {
    const { spawn } = await import('node:child_process')
    const http = await import('node:http')
    const net = await import('node:net')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    // A FREE port, not a fixed one: two probe instances racing on a fixed
    // port connect to EACH OTHER's chromium and every later step reads a
    // stranger's state (measured). Bind :0, note the assignment, release.
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => (typeof p === 'number' ? resolve(p) : reject(new Error('no ephemeral port'))))
      })
      srv.on('error', reject)
    })
    const userDataDir = mkdtempSync(join(tmpdir(), 'pm-probe-cdp-'))
    const cdpProc = spawn(chromium.executablePath(), [
      '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', `--user-data-dir=${userDataDir}`, 'about:blank',
    ], { stdio: 'ignore' })
    try {
      let up = false
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise((r) => setTimeout(r, 250))
        up = await new Promise((res) => http.get(`http://127.0.0.1:${port}/json/version`, (r2) => { r2.resume(); res(true) }).on('error', () => res(false)))
      }
      ok(up, 'CDP endpoint came up')
      const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      try {
        const ctx = cdp.contexts()[0] ?? (await cdp.newContext())
        const cdpPage = ctx.pages()[0] ?? (await ctx.newPage())
        await cdpPage.setContent('<html><body><button id="b" onclick="window.__clicked=(window.__clicked||0)+1">CDP按钮</button></body></html>')
        const cdpSnap = await takeDomSnapshot(cdpPage)
        const cdpBtnRef = (function find(tree) {
          for (const n of tree) {
            if (n.role === 'button') return n.ref
            const r = find(n.children ?? [])
            if (r) return r
          }
        })(cdpSnap.tree)
        check('app-view 路径（connectOverCDP）：mode:ai 快照带 ref', () => {
          ok(cdpBtnRef, 'button carries an engine ref over CDP')
          ok(cdpSnap.text.includes('CDP按钮'))
        })
        await runPlaywrightOp(cdpPage, { selector: `aria-ref=${cdpBtnRef}`, op: 'click' }, cdpSnap.tree)
        const cdpAfter = await cdpPage.evaluate(() => window.__clicked || 0)
        check('app-view 路径：aria-ref click 真实落地', () => { eq(cdpAfter, 1) })
      } finally {
        // A raced/torn CDP transport can make close() never settle — the
        // spawn kill below is the real teardown, this is just polite.
        await Promise.race([cdp.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
      }
    } finally {
      cdpProc.kill('SIGKILL')
      // SIGKILL is async — the profile files still exist for a beat; deleting
      // into a dying chrome ENOTEMPTYs (measured). Wait it out, then clean.
      await Promise.race([
        new Promise((r) => cdpProc.once('exit', r)),
        new Promise((r) => setTimeout(r, 3000)),
      ])
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* best-effort: the OS temp cleaner owns whatever chrome still held */
      }
    }
  }

  console.log('PASS: ' + checks + ' checks — AI 快照 + 差分观察在真实 Chromium 上成立')
  // The probe's contract is its output; a lingering CDP transport handle must
  // not keep the process (and the caller's pipeline) hanging past it.
  process.exit(0)
} finally {
  await browser.close()
}
