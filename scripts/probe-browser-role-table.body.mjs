// review_20260927 中1 — IMPLICIT/INPUT roleSet 表对表：把
// PlaywrightCommands.ts 的 ROLE_SET_TABLES 逐条喂给真实 Chromium 的 AI 快照，
// 断言「快照打印的每个 role ∈ 表集合 ∪ 陪衬集合」。表外的 role 就是误拒——
// 高1（tag 当 role）和中1（规范值 vs 实测值：<summary> 打印 generic、
// <input list> 打印 combobox、<dl> 打印 generic）都是这个形状的死循环，而
// 这类漂移只有真浏览器能抓。缺席也是安全侧：不进快照的元素拿不到 ref，
// 永远不会被比较（optional fixture）。运行：node scripts/probe-browser-role-table.mjs
import { chromium } from 'playwright-core'
import { ROLE_SET_TABLES, runPlaywrightOp } from '../src/main/browser/PlaywrightCommands.ts'
import { takeDomSnapshot } from '../src/main/browser/snapshot-refs.ts'
import { pmRefSelector } from '../src/shared/browser-client/pm-refs.ts'

let checks = 0
// 异步 on purpose：几个 case 的断言要等真点击落定，失败必须把整条 run 打红，
// 而不是一个无人等候的 rejection。
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label) }
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'expected truthy') }

// 子树 role 巡查。role 'text' 是 AI 模式给无 ref 散文的 role（<a> 无 href、
// canvas 回退文本），永远不带 ref → 永远不会被寻址，不参与对表。
const rolesOf = (tree) => {
  const roles = []
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (typeof n === 'string') continue
      if (n.role !== 'text') roles.push(n.role)
      walk(n.children)
    }
  }
  walk(tree)
  return roles
}

// 每个 tag 一个最小 fixture：快照 locator 的子树，ignore = 陪衬节点（祖先 /
// 兄弟，各自有自己的表条目、由其 fixture 覆盖），optional = 该元素合法地
// 不进快照。fixture 形态全部实测选定（命名 form/section 才打印；dl 必须
// 断言 generic；th 整表语境 rowheader、根语境 generic——两种都要）。
const TAG_FIXTURES = [
  ['html', '<p>only</p>', 'html', ['generic', 'paragraph']],
  ['nav', '<nav><a href="/x">x</a></nav>', 'nav', ['link']],
  ['h1', '<h1>H1</h1>', 'h1', []],
  ['h2', '<h2>H2</h2>', 'h2', []],
  ['h3', '<h3>H3</h3>', 'h3', []],
  ['h4', '<h4>H4</h4>', 'h4', []],
  ['h5', '<h5>H5</h5>', 'h5', []],
  ['h6', '<h6>H6</h6>', 'h6', []],
  ['form', '<form aria-label="f"><input></form>', 'form', ['textbox']],
  ['section', '<section aria-label="s"><p>x</p></section>', 'section', ['paragraph']],
  ['article', '<article><p>x</p></article>', 'article', ['paragraph']],
  ['aside', '<aside><p>x</p></aside>', 'aside', ['paragraph']],
  ['header', '<header>h</header>', 'header', []],
  ['footer', '<footer>f</footer>', 'footer', []],
  ['main', '<main>m</main>', 'main', []],
  ['textarea', '<textarea>ta</textarea>', 'textarea', []],
  ['select', '<select><option>o</option></select>', 'select', ['option']],
  ['button', '<button>b</button>', 'button', []],
  ['summary', '<details open><summary>s</summary><p>b</p></details>', 'summary', ['group', 'paragraph']],
  ['summary', '<summary>s</summary>', 'summary', []],
  ['a', '<a href="#x">l</a>', 'a', []],
  ['img', '<img alt="pic">', 'img', []],
  ['svg', '<svg viewBox="0 0 10 10"><title>t</title><circle cx="5" cy="5" r="4"></circle></svg>', 'svg', []],
  ['canvas', '<canvas width="10" height="10"></canvas>', 'canvas', [], true],
  ['ul', '<ul><li>i</li></ul>', 'ul', ['listitem']],
  ['ol', '<ol><li>i</li></ol>', 'ol', ['listitem']],
  ['menu', '<menu><li>i</li></menu>', 'menu', ['listitem']],
  ['li', '<ul><li>i</li></ul>', 'li', ['list']],
  ['dl', '<dl><dt>t</dt><dd>d</dd></dl>', 'dl', ['term', 'definition']],
  ['dt', '<dl><dt>t</dt><dd>d</dd></dl>', 'dt', []],
  ['dd', '<dl><dt>t</dt><dd>d</dd></dl>', 'dd', []],
  ['fieldset', '<fieldset><legend>lg</legend><input></fieldset>', 'fieldset', ['textbox']],
  ['details', '<details open><summary>s</summary><p>b</p></details>', 'details', ['generic', 'paragraph']],
  ['optgroup', '<select><optgroup label="g"><option>o</option></optgroup></select>', 'select optgroup', ['option'], true],
  ['dialog', '<dialog open>dlg</dialog>', 'dialog', []],
  ['p', '<p>para</p>', 'p', []],
  ['blockquote', '<blockquote>bq</blockquote>', 'blockquote', []],
  ['hr', '<hr>', 'hr', []],
  ['table', '<table><tr><td>c</td></tr></table>', 'table', ['rowgroup', 'row', 'cell']],
  ['thead', '<table><thead><tr><td>h</td></tr></thead></table>', 'thead', ['row', 'cell']],
  ['tbody', '<table><tbody><tr><td>b</td></tr></tbody></table>', 'tbody', ['row', 'cell']],
  ['tfoot', '<table><tfoot><tr><td>f</td></tr></tfoot></table>', 'tfoot', ['row', 'cell']],
  ['tr', '<table><tr><td>c</td></tr></table>', 'tr', ['cell']],
  ['td', '<table><tr><td>c</td></tr></table>', 'td', []],
  // th 的两个实测形态：整表语境打印 rowheader（无 scope 的默认），根语境打印 generic
  ['th', '<table><tr><th>h</th><td>c</td></tr></table>', 'table', ['table', 'rowgroup', 'row', 'cell']],
  ['th', '<table><tr><th>h</th></tr></table>', 'th', []],
  ['option', '<select><option>o</option></select>', 'option', ['combobox']],
  ['datalist', '<input list="dl"><datalist id="dl"><option value="a"></datalist>', 'datalist', [], true],
  ['progress', '<progress value="5" max="10"></progress>', 'progress', []],
  ['meter', '<meter value="5" min="0" max="10"></meter>', 'meter', []],
  ['output', '<output>out</output>', 'output', []],
  ['figure', '<figure><p>f</p></figure>', 'figure', ['paragraph']],
  ['iframe', '<iframe srcdoc="<p>inner</p>" title="fr"></iframe>', 'iframe', ['paragraph']],
]

const assertFixtureRoles = (label, roles, set, ignore) => {
  const foreign = roles.filter((r) => !set.includes(r) && !ignore.includes(r))
  ok(foreign.length === 0, `${label}: 快照打印了表外的 role [${foreign.join(',')}]（集合 [${set.join(',')}]）——会在动作时误拒`)
  return foreign
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const snap = async (selector) => page.locator(selector).ariaSnapshotJSON({ mode: 'ai' })

  // ── 1. IMPLICIT 表逐条 ──
  for (const [tag, html, sel, ignore, optional] of TAG_FIXTURES) {
    await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`)
    const roles = rolesOf(await snap(sel))
    const set = ROLE_SET_TABLES.implicit[tag]
    await check(`${tag}（${sel}）：[${roles.join(',') || '缺席'}] ⊆ [${set.join(',')}]${ignore.length ? ' + 陪衬 [' + ignore.join(',') + ']' : ''}`, () => {
      assertFixtureRoles(tag, roles, set, ignore)
      if (!optional) ok(roles.some((r) => set.includes(r)), `${tag}: fixture 没打出集合内任何 role，fixture 失效（空转）`)
    })
  }

  // ── 2. input type 表逐条（无 list）──
  for (const [type, set] of Object.entries(ROLE_SET_TABLES.inputTypes)) {
    await page.setContent(`<!DOCTYPE html><html><body><input type="${type}" aria-label="in"></body></html>`)
    const roles = rolesOf(await snap('input'))
    if (set === null) {
      console.log(`  ·   input type=${type}：表置 null 跳过（实测 [${roles.join(',')}]）`)
      continue
    }
    await check(`input type=${type}：[${roles.join(',') || '缺席'}] ⊆ [${set.join(',')}]`, () => {
      assertFixtureRoles(`input type=${type}`, roles, set, [])
      ok(roles.some((r) => set.includes(r)), `input type=${type}: fixture 失效（空转）`)
    })
  }

  // ── 3. 中1：文本类 input + list → combobox ──
  const listPage = '<input aria-label="in" list="dl"><datalist id="dl"><option value="a"></datalist>'
  await page.setContent(`<!DOCTYPE html><html><body>${listPage}</body></html>`)
  await check('input(无type)+list → combobox ∈ textLikeWithList', async () => {
    const roles = rolesOf(await snap('input'))
    assertFixtureRoles('input+list', roles, ROLE_SET_TABLES.textLikeWithList, [])
    ok(roles.includes('combobox'), `input+list 应打印 combobox，实测 [${roles.join(',')}]`)
  })

  // ── 4. 派生表逐格：每个 type + list ──
  for (const [type, set] of Object.entries(ROLE_SET_TABLES.inputTypesWithList)) {
    await page.setContent(`<!DOCTYPE html><html><body><input type="${type}" aria-label="in" list="dl"><datalist id="dl"><option value="a"></datalist></body></html>`)
    const roles = rolesOf(await snap('input'))
    if (set === null) {
      console.log(`  ·   input type=${type}+list：表置 null 跳过（实测 [${roles.join(',')}]）`)
      continue
    }
    await check(`input type=${type}+list：[${roles.join(',') || '缺席'}] ⊆ [${set.join(',')}]`, () => {
      assertFixtureRoles(`input type=${type}+list`, roles, set, [])
      ok(roles.some((r) => set.includes(r)), `input type=${type}+list: fixture 失效（空转）`)
    })
  }

  // ── 5. 端到端：中1 的两类元素走真 verify 路径不再误拒 ──
  // 修复前：<summary> 快照 role 是 generic、表只认 button → 每次 click 都抛
  // 「编号已失效……页面复用了节点」，重拍快照也无法自拔。
  await page.setContent('<details open><summary>展开</summary><p>b</p></details>')
  const detailsSnap = await takeDomSnapshot(page)
  const findRef = (tree, role, name) => {
    let found = null
    const walk = (nodes) => {
      for (const n of nodes ?? []) {
        if (typeof n === 'string') continue
        if (!found && n.role === role && (n.name ?? '') === name && n.ref) found = n.ref
        walk(n.children)
      }
    }
    walk(tree)
    return found
  }
  const sumRef = findRef(detailsSnap.tree, 'generic', '展开')
  await check('summary 元素拿到 ref 并通过完整 verify 点击', async () => {
    ok(sumRef, 'summary 没拿到 ref')
    const result = await runPlaywrightOp(page, { selector: pmRefSelector(sumRef), op: 'click' }, detailsSnap.tree)
    ok(result === 'clicked', `点击应成功，实际 ${JSON.stringify(result)}`)
  })

  await page.setContent('<input aria-label="q" list="dl"><datalist id="dl"><option value="a"></datalist>')
  const comboSnap = await takeDomSnapshot(page)
  const comboRef = findRef(comboSnap.tree, 'combobox', 'q')
  check('input+list（combobox）拿到 ref 并通过完整 verify 点击', async () => {
    ok(comboRef, 'input+list 没拿到 ref')
    // 点击 combobox 不产生页面变化，change-watch 的负向注解是设计行为——
    // 这里的断言是「verify 放行、手势落地」，绝不是「编号已失效」的误拒。
    const result = await runPlaywrightOp(page, { selector: pmRefSelector(comboRef), op: 'click' }, comboSnap.tree)
    ok(String(result).startsWith('clicked'), `点击应落地，实际 ${JSON.stringify(result)}`)
  })

  console.log('PASS: ' + checks + ' checks — roleSet 表与真实 Chromium 的 AI 快照逐条一致')
  process.exit(0)
} finally {
  await browser.close()
}
