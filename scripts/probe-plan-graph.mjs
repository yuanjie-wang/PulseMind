/**
 * Real-browser render of the workbench's plan DAG view (PLAN-workbench W6/W9/
 * W10/W11). A graph's look cannot be reviewed from source — jsdom has no
 * layout engine and SVG text has no metrics there — so this probe mounts the
 * *real* PlanGraphView with realistic fixtures and asserts, in pixels:
 *
 *  - every text line sits INSIDE its node card with a real margin;
 *  - every edge leaves the source's flow+ edge and enters the target's
 *    flow− edge, per the CHOSEN orientation (auto: horizontal vs vertical is
 *    decided by viewport fit — the probe recomputes both layouts and pins
 *    the view's choice);
 *  - no edge passes through a node it does not belong to;
 *  - 开始/结束 anchor pills render and every module sits on a connected line;
 *  - ready nodes carry the breathing pulse and it actually animates;
 *  - a deep chain flips the auto decision to vertical flow.
 *
 * Usage: node scripts/probe-plan-graph.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-plan-graph-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Inline harness (esbuild stdin) importing the production component — a copy
 *  here would prove nothing about what ships. */
const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { PlanGraphView } from './src/renderer/src/components/workbench/PlanGraphView'
import { ensureCache } from './src/renderer/src/agent/mcp-cache'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { createPlanDag } from './src/shared/plan/graph'

// The graph is migrated onto the theme sheet (PLAN-dark-mode M3/T2): the SVG
// strokes and fills now read var(--pm-*), so the page needs the variable table
// injected before the component renders. Light is pinned explicitly — this
// probe freezes the light graph; the dark column is probe-theme-dark's.
installThemeVars()
applyThemeAttr('light')
import { blockedNodes, readyNodes } from './src/shared/plan/graph'
import { layoutPlanGraph } from './src/shared/plan/layout'

// Expert list for the id → name resolution. The plan stores IDs; the card must
// show names. This drives the production path (the renderer bridge + the cache
// subscription) rather than injecting a ready-made name map.
window.electronAPI = {
  expertList: async () => [
    { id: 'exp_product', name: '产品专家' },
    { id: 'exp_frontend', name: '前端专家' },
    { id: 'exp_backend', name: '后端专家' },
    { id: 'exp_docs', name: '技术文档编写与知识库运营专家' },
  ],
  mcpListServers: async () => [],
  getSkillPreferences: async () => ({ enabledSkills: [], skillKeywords: {} }),
  onMcpServersChanged: () => () => {},
  onSkillsChanged: () => () => {},
}
window.__cacheReady = ensureCache()

// Realistic mid-execution plan: every status, real expert ids as assignees
// (never the names — that is the bug being pinned), long CJK text, a skip-level
// dependency (n1 → n6 across two waves), a failed chain, and an EARLY terminal
// (n7 settles in wave 2 — its line to 结束 must detour instead of cutting
// through the last wave's cards).
const plan = createPlanDag('上线多专家协作版本', [
  { description: '调研竞品的协作功能与用户反馈，输出调研纪要' },
  { description: '撰写需求文档并评审', dependsOn: [1], assignee: 'exp_product' },
  { description: '设计技术方案与接口约定', dependsOn: [1] },
  { description: '前端页面开发与联调', dependsOn: [2], assignee: 'exp_frontend' },
  { description: '后端接口开发', dependsOn: [2], assignee: 'exp_backend' },
  { description: '集成测试、回归与发布上线', dependsOn: [1, 3, 4, 5] },
  { description: '编写用户使用手册', dependsOn: [2], assignee: 'exp_product' },
])
plan.nodes[0].status = 'completed'
plan.nodes[0].msgId = 'msg-1'
plan.nodes[0].summary = '调研完成，见对话'
plan.nodes[4].status = 'failed'
plan.nodes[4].summary = '上游接口变更导致阻塞'

// Fresh plan (short chain) and a DEEP chain (vertical should win for it).
const fresh = createPlanDag('整理一份行业研究报告', [
  { description: '收集资料' },
  { description: '整理大纲', dependsOn: [1], assignee: 'exp_docs' },
  { description: '撰写正文', dependsOn: [2] },
])
const chain = createPlanDag('十步串行流水', Array.from({ length: 6 }, (_, i) => ({
  description: '步骤 ' + (i + 1),
  ...(i > 0 ? { dependsOn: [i] } : {}),
})))

// Expected geometry per fixture/direction, for pinning the view's auto choice.
const geo = (p) => ({ h: layoutPlanGraph(p, 'horizontal'), v: layoutPlanGraph(p, 'vertical') })
// Which STATE each card should dress as — ready/blocked are derived, so the
// probe reads them from the same pure functions the view uses.
const states = (p) => {
  const ready = new Set(readyNodes(p).map(n => n.id))
  const blocked = new Set(blockedNodes(p).map(n => n.id))
  return Object.fromEntries(p.nodes.map(n =>
    [n.id, n.status === 'pending' ? (ready.has(n.id) ? 'ready' : blocked.has(n.id) ? 'blocked' : 'pending') : n.status]))
}
// 跳过 has no fixture of its own in mid, and status does not move geometry.
fresh.nodes[2].status = 'skipped'
window.__states = { mid: states(plan), fresh: states(fresh), chain: states(chain) }
window.__geo = { mid: geo(plan), fresh: geo(fresh), chain: geo(chain) }

function Mount({ id, p }) {
  return (
    <div id={id} style={{ width: 420, height: 560, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={p} onJumpToStep={() => {}} />
    </div>
  )
}

/** Same plan in a box big enough for its whole horizontal layout, so the
 *  auto-fit sits at scale 1 and the cards can be read at real size — the 420px
 *  pane shrinks them to ~60%. */
function ZoomMount({ p }) {
  return (
    <div id="zoom" style={{ width: 1200, height: 420, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={p} onJumpToStep={() => {}} />
    </div>
  )
}

/** The header's objective: two lines by default, 展开 when there is more. */
const longObjective = { ...plan, objective: '把这一版的多专家协作能力完整落地：先调研竞品与用户反馈，再定技术方案与接口约定，前端与后端并行开发，最后集成测试、回归并发布上线，同时补一份用户使用手册' }
function HeadMount({ p }) {
  return (
    <div id="head" style={{ width: 420, height: 560, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={p} onJumpToStep={() => {}} />
    </div>
  )
}

// Click fixture (PLAN-workbench W12): the user-reported 「点击任务模块，没有跳转」.
// A real mouse must reach the handler, and each node's clickability must match
// what it can actually open — a linked node, a settled node, and a node with
// neither (a plan the model never dispatched) side by side.
const clickPlan = createPlanDag('点击节点进入子代理会话', [
  { description: '已派发给子代理' },
  { description: '主对话自己完成' },
  { description: '既没派发也没结算' },
])
clickPlan.nodes[0].subConvId = 'sub_linked'
clickPlan.nodes[0].status = 'pending'
clickPlan.nodes[1].status = 'completed'
clickPlan.nodes[1].msgId = 'msg-done'

function ClickMount() {
  // n3 is the node the model never dispatched: no session, no settling round —
  // exactly what App's resolvePlanNodeTarget returns null for, which is what
  // canOpenNode reports back here.
  const canOpenNode = (nodeId) => nodeId !== 'n3'
  return (
    <div id="click" style={{ width: 420, height: 320, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView
        plan={clickPlan}
        onJumpToStep={(msgId) => { (window.__clicks = window.__clicks || []).push(['jump', msgId]) }}
        onOpenPlanNode={(nodeId) => { (window.__clicks = window.__clicks || []).push(['open', nodeId]) }}
        canOpenNode={canOpenNode}
      />
    </div>
  )
}

/** Narrow pane: the graph never shrinks (canvas D1, floor 1), so this is the
 *  one mount where centring must NOT apply — auto margins have to collapse to 0
 *  or the 开始 anchor would be pushed out of reach to the left. */
function NarrowMount() {
  return (
    <div id="narrow" style={{ width: 200, height: 300, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={plan} onJumpToStep={() => {}} />
    </div>
  )
}

/** Canvas fixture (PLAN-plan-graph-canvas M4): a 300px pane + a click
 *  recorder, for pan / click-guard / reset assertions with a real mouse. */
window.__canvasClicks = []
function CanvasMount() {
  return (
    <div id="canvas" style={{ width: 300, height: 400, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={plan} onJumpToStep={() => {}} canOpenNode={() => true}
        onOpenPlanNode={(id) => { window.__canvasClicks.push(['open', id]) }} />
    </div>
  )
}

// Report fixture (PLAN-plan-exchange 表达面): delivered cards carrying a
// system-minted reportPath. n1 declares 部分成功 against a completed
// acceptance — the divergence is exactly what the chip exists to name — and
// carries a LONG expert name so the row-2 clip (13 → 8 glyphs when the link
// takes the row's right end) is the real collision case. n2 declares 成功:
// link only, no chip (the acceptance word already says it). The link's click
// must open the report and NOT the session drill-down behind it.
const reportPlan = createPlanDag('报告契约表达面', [
  { description: '产出数据分析报告', assignee: 'exp_docs' },
  { description: '汇总为执行简报', dependsOn: [1] },
])
reportPlan.nodes[0].status = 'completed'
reportPlan.nodes[0].reportPath = '/ws/.pulsemind/plans/plan_r/n1-report.md'
reportPlan.nodes[0].declaredStatus = 'partial'
reportPlan.nodes[1].status = 'completed'
reportPlan.nodes[1].reportPath = '/ws/.pulsemind/plans/plan_r/n2-report.md'
reportPlan.nodes[1].declaredStatus = 'success'

function ReportMount() {
  return (
    <div id="report" style={{ width: 760, height: 420, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView
        plan={reportPlan}
        onJumpToStep={() => {}}
        onOpenPlanNode={(id) => { (window.__clicks = window.__clicks || []).push(['open', id]) }}
        onOpenNodeReport={(id) => { (window.__clicks = window.__clicks || []).push(['report', id]) }}
      />
    </div>
  )
}

// Highlight fixture (查看子代理会话时面板对应模块高亮): the drill-in is open on
// n2's session, so n2's card wears the accent while its neighbours keep the
// grey sheet — and the null mount is the closed-drill-in control, where no
// card may carry it.
function HighlightMount({ highlightNodeId }: { highlightNodeId: string | null }) {
  return (
    <div id={highlightNodeId ? 'highlight' : 'nohighlight'} style={{ width: 420, height: 420, border: '1px solid #ccc', position: 'relative' }}>
      <PlanGraphView plan={fresh} onJumpToStep={() => {}} highlightNodeId={highlightNodeId} />
    </div>
  )
}

createRoot(document.getElementById('app')).render(
  <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
    <div style={{ display: 'flex', gap: 16, padding: 16, background: '#fff', flexWrap: 'wrap' }}>
      <Mount id="mid" p={plan} />
      <Mount id="fresh" p={fresh} />
      <Mount id="chain" p={chain} />
      <ZoomMount p={plan} />
      <HeadMount p={longObjective} />
      <ClickMount />
      <ReportMount />
      <HighlightMount highlightNodeId="n2" />
      <HighlightMount highlightNodeId={null} />
      <NarrowMount />
      <CanvasMount />
    </div>
  </ConfigProvider>
)
`
const OUT = 'out/probe-plan-graph.js'
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), sourcefile: 'probe-plan-graph.tsx', loader: 'tsx' },
  bundle: true,
  outfile: OUT,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning'
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1400, height: 700 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForSelector('#mid [data-node="n1"]', { timeout: 15000 })
await page.waitForTimeout(150) // ResizeObserver → direction + scale settle

/** Per-container geometry facts, measured in the page. */
async function gather(id) {
  return page.evaluate((containerId) => {
    const svg = document.querySelector(`#${containerId} svg`)
    const nodeRects = new Map()
    for (const g of svg.querySelectorAll('g[data-node]')) {
      const rect = g.querySelector('rect')
      nodeRects.set(g.dataset.node, {
        x: +rect.getAttribute('x'), y: +rect.getAttribute('y'),
        w: +rect.getAttribute('width'), h: +rect.getAttribute('height'),
      })
    }
    const texts = []
    for (const g of svg.querySelectorAll('g[data-node]')) {
      const r = nodeRects.get(g.dataset.node)
      for (const t of g.querySelectorAll('text')) {
        const b = t.getBBox()
        texts.push({
          node: g.dataset.node, text: (t.textContent || '').slice(0, 12),
          leftMargin: +(b.x - r.x).toFixed(1),
          rightOver: +(b.x + b.width - (r.x + r.w)).toFixed(1),
          topMargin: +(b.y - r.y).toFixed(1),
          bottomOver: +(b.y + b.height - (r.y + r.h)).toFixed(1),
        })
      }
    }
    const PADDING = 2
    const edges = []
    for (const p of svg.querySelectorAll('path[marker-end]')) {
      const len = p.getTotalLength()
      const at = (d) => { const pt = p.getPointAtLength(Math.max(0, Math.min(len, d))); return { x: pt.x, y: pt.y } }
      const pts = Array.from({ length: 40 }, (_, i) => at((len * i) / 39))
      const d = p.getAttribute('d')
      // Horizontal over-paths ride a horizontal bus (the lane is the 3rd
      // point's y); vertical over-paths ride a left rail (the lane is the
      // 3rd point's x).
      const laneH = d.match(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ ([\d.]+) L/)
      const laneV = d.match(/^M [\d.]+ [\d.]+ L ([\d.]+) [\d.]+ L [\d.]+ [\d.]+ L/)
      edges.push({
        d,
        over: Boolean(laneH || laneV),
        lane: laneH ? +laneH[1] : laneV ? +laneV[1] : null,
        start: pts[0], end: pts[pts.length - 1],
        crossings: pts
          .filter((pt) =>
            [...nodeRects.entries()].some(([, r]) =>
              pt.x > r.x + PADDING && pt.x < r.x + r.w - PADDING &&
              pt.y > r.y + PADDING && pt.y < r.y + r.h - PADDING))
          .length,
        starts: pts.slice(0, 3), ends: pts.slice(-3),
      })
    }
    const vp = svg.closest('[data-graph-viewport]')
    const vr = vp.getBoundingClientRect()
    const sr = svg.getBoundingClientRect()
    return {
      svgW: +svg.getAttribute('width'), svgH: +svg.getAttribute('height'),
      viewportW: vp.clientWidth,
      viewportH: vp.clientHeight,
      // Slack on each side of the graph, in CSS px, with the scroll offset
      // removed so a scrolled-to-the-end view still reports its real gaps.
      // clientWidth is the padding box, so it is the content's right edge.
      gapLeft: +(sr.left - (vr.left + vp.scrollLeft)).toFixed(1),
      gapRight: +((vr.left + vp.clientWidth) - sr.right).toFixed(1),
      rects: Object.fromEntries(nodeRects),
      texts, edges,
    }
  }, id)
}

const geo = await page.evaluate(() => window.__geo)
const facts = { mid: await gather('mid'), fresh: await gather('fresh'), chain: await gather('chain') }
const narrow = await gather('narrow')

/** The auto-decision the view SHOULD have made + the scale it should apply —
 *  computed from the SAME measured scroll viewport the view reads. */
function expected(id) {
  const g = geo[id]
  const { viewportW: w, viewportH: h } = facts[id]
  const rH = Math.min(w / g.h.width, h / g.h.height, 1)
  const rV = Math.min(w / g.v.width, h / g.v.height, 1)
  const direction = rV > rH ? 'vertical' : 'horizontal'
  const l = direction === 'vertical' ? g.v : g.h
  // PLAN-plan-graph-canvas D1: the floor is 1 — the graph never shrinks; a
  // narrow pane pans instead. (fit ratios still pick the direction.)
  const scale = Math.max(1, Math.min(1, direction === 'vertical' ? rV : rH))
  return { direction, w: l.width * scale, h: l.height * scale }
}

for (const id of ['mid', 'fresh', 'chain']) {
  const exp = expected(id)
  const f = facts[id]
  // Flow direction is a semantic fact, not an aspect ratio: where the 结束
  // anchor sits relative to 开始.
  const startR = f.rects['__start__']
  const endR = f.rects['__end__']
  const flowVertical = startR && endR
    ? Math.abs(endR.y - startR.y) > Math.abs(endR.x - startR.x)
    : exp.direction === 'vertical'
  check(`[${id}] auto picks the better-fitting direction (${exp.direction})`,
    exp.direction === 'vertical' ? flowVertical : !flowVertical,
    `svg ${f.svgW}×${f.svgH}, expected ${exp.direction} ${Math.round(exp.w)}×${Math.round(exp.h)}`)
  check(`[${id}] svg size matches the chosen layout at its scale`,
    Math.abs(f.svgW - exp.w) < 1.5 && Math.abs(f.svgH - exp.h) < 1.5,
    `svg ${f.svgW}×${f.svgH} vs expected ${exp.w.toFixed(1)}×${exp.h.toFixed(1)}`)
  // 用户反馈 2026-09-16「DAG 图要水平居中」：缩放到比面板窄时图形贴在左边，
  // 右边空一大片。规则是——有余量就两边等宽，没有余量（图比面板宽）就贴左，
  // 否则开始锚点会被推出可视区。
  const overflowsW = f.svgW > f.viewportW + 0.5
  const centered = overflowsW
    ? Math.abs(f.gapLeft) < 1.5
    : Math.abs(f.gapLeft - f.gapRight) < 1.5
  check(`[${id}] the graph is centred horizontally in its viewport`, centered,
    `gaps left=${f.gapLeft} right=${f.gapRight} (svg ${f.svgW}, viewport ${f.viewportW})`)

  // The other side of the same rule: a pane too narrow for even the 0.55 floor
  // must keep the graph flush left (auto margins collapse), never centred — a
  // centred overflowing graph clips its own 开始 anchor.
  if (id === 'mid') {
    check('[narrow] a pane too narrow for the floor keeps the graph flush left, not centred',
      narrow.svgW > narrow.viewportW + 0.5 && Math.abs(narrow.gapLeft) < 1.5,
      `svg ${narrow.svgW} vs viewport ${narrow.viewportW}, gapLeft=${narrow.gapLeft}`)
  }

  // Text containment — the "文字挤到一起" killer.
  const overflows = f.texts.filter(t => t.leftMargin < 3 || t.rightOver > -3 || t.topMargin < 2 || t.bottomOver > -2)
  check(`[${id}] every text sits inside its node card`, overflows.length === 0,
    overflows.slice(0, 3).map(o => `[${o.node}] "${o.text}"`).join('; '))

  // Edge endpoints per orientation + no crossing.
  const near = (a, b, tol = 3) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
  let endsOk = true
  const endsBad = []
  const links = []
  for (const e of f.edges) {
    let src, dst
    if (exp.direction === 'vertical') {
      src = Object.entries(f.rects).find(([, r]) => near(e.start, { x: r.x + r.w / 2, y: r.y + r.h }))
      dst = e.over
        ? Object.entries(f.rects).find(([, r]) => near(e.end, { x: e.end.x, y: r.y }, 0.5) && e.end.x > r.x + 8 && e.end.x < r.x + r.w - 8)
        : Object.entries(f.rects).find(([, r]) => near(e.end, { x: r.x + r.w / 2, y: r.y }))
    } else {
      src = Object.entries(f.rects).find(([, r]) => near(e.start, { x: r.x + r.w, y: r.y + r.h / 2 }))
      dst = e.over
        ? Object.entries(f.rects).find(([, r]) => near(e.end, { x: r.x, y: e.end.y }, 0.5) && e.end.y > r.y + 8 && e.end.y < r.y + r.h - 8)
        : Object.entries(f.rects).find(([, r]) => near(e.end, { x: r.x, y: r.y + r.h / 2 }))
    }
    if (!src || !dst) { endsOk = false; endsBad.push(e.d.slice(0, 26)) }
    else links.push({ from: src[0], to: dst[0] })
  }
  check(`[${id}] every edge leaves the source flow+ edge and enters the target flow− edge`, endsOk,
    endsBad.length ? `${endsBad.length} bad: ${endsBad.join('; ')}` : `${f.edges.length} edges sampled`)
  check(`[${id}] no edge passes through a node`, f.edges.every(e => e.crossings === 0),
    f.edges.filter(e => e.crossings > 0).map(e => e.d.slice(0, 26)).join('; '))

  const hasOut = new Set(links.map(l => l.from))
  const hasIn = new Set(links.map(l => l.to))
  const floating = Object.keys(f.rects).filter(id2 =>
    (id2 !== '__end__' && !hasOut.has(id2)) || (id2 !== '__start__' && !hasIn.has(id2)))
  check(`[${id}] every module is on a connected line (起点 → … → 终点)`, floating.length === 0,
    floating.length ? `floating: ${floating.join(', ')}` : `${links.length} links / ${Object.keys(f.rects).length} nodes`)
}

// ── Container-specific facts ──
const midTexts = facts.mid.texts
check('[mid] node cards carry label + description lines, anchors carry their word',
  midTexts.length >= 7 * 3 + 2, `${midTexts.length} texts (7 task nodes + 开始/结束)`)
check('[mid] start/end anchor pills render (开始 / 结束)',
  midTexts.some(t => t.node === '__start__' && t.text.includes('开始'))
    && midTexts.some(t => t.node === '__end__' && t.text.includes('结束')),
  midTexts.filter(t => t.node.startsWith('__')).map(t => `${t.node}:${t.text}`).join(', '))

// ── Card anatomy (user ruling 2026-09-16) ──
// 第一行：编号（左）+ 执行状态 icon（右）；第二行：执行者；第三行起：任务内容。
// 卡片白底、灰边框，状态只靠「字形 + 灰度对比」表达；文字按重要性分黑灰阶。
// 全图唯一的色相是失败的那个叉。
// Colours arrive in two forms: the status hues as hex literals and the sheet
// roles as resolved rgb() strings (the harness resolves var() before shipping
// them over), so both parsers accept either.
const parseCol = (v) => {
  const h = /^#([0-9a-f]{6})$/i.exec((v ?? '').trim())
  if (h) { const n = parseInt(h[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
  const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(v ?? '')
  return m ? [+m[1], +m[2], +m[3]] : null
}
const isGrey = (v) => {
  const c = parseCol(v)
  return !!c && c[0] === c[1] && c[1] === c[2]
}
const lum = (v) => {
  const c = parseCol(v)
  return c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : NaN
}
const ICON_OF = { ready: 'spinner', blocked: 'ban', completed: 'check', failed: 'cross', skipped: 'minus', pending: 'circle' }
/** The only two hues in the view, and they may ride glyphs only (user ruling:
 *  completed = a green disc with a white check, failure = a brick cross). */
const DONE_GREEN = '#34a853'
const FAILED_RED = '#b4453c'
const STATUS_WORDS = ['就绪', '阻塞', '已完成', '失败', '跳过']
const expectStates = await page.evaluate(() => window.__states)
const stateOf = (c) => expectStates[c.container][c.node]

const anatomy = await page.evaluate(() => {
  const cards = []
  for (const id of ['mid', 'fresh']) {
    for (const g of document.querySelectorAll(`#${id} g[data-node]`)) {
      const rect = g.querySelector('rect')
      const icon = g.querySelector('[data-icon]')
      // getBBox() is in the glyph's OWN space; the only transform on it is the
      // translate the view applies, so re-add that to land in card coordinates.
      const at = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(icon?.getAttribute('transform') ?? '')
      const box = icon && at ? { x: +at[1], y: +at[2] } : null
      const bb = icon ? icon.getBBox() : null
      // The graph's inks ride the theme sheet (PLAN-dark-mode M3/T2): the
      // attributes carry var(--pm-*) strings, so every colour read resolves
      // through a throwaway box BEFORE the node side parses it. Status hues
      // (#34a853/#b4453c) stay literals and pass through untouched.
      const res = (raw) => {
        if (!raw || raw.indexOf('var(') < 0) return raw
        const d = document.createElement('div')
        d.style.color = raw
        document.body.appendChild(d)
        const v = getComputedStyle(d).color
        d.remove()
        return v
      }
      cards.push({
        container: id, node: g.dataset.node, terminal: g.dataset.node.startsWith('__'),
        fill: res(rect.getAttribute('fill')), border: res(rect.getAttribute('stroke')),
        dash: rect.getAttribute('stroke-dasharray'),
        cardX: +rect.getAttribute('x'), cardY: +rect.getAttribute('y'), cardW: +rect.getAttribute('width'),
        icon: icon?.dataset.icon ?? null,
        // Stroke-drawn glyphs need their stroke, filled ones their fill.
        iconInk: icon
          ? [...icon.querySelectorAll('circle,path,line,polyline,rect')].map(c => res(c.getAttribute('fill') === 'none' ? c.getAttribute('stroke') : c.getAttribute('fill')))
          : [],
        iconBox: box && bb
          ? { left: box.x + bb.x, right: box.x + bb.x + bb.width, centerY: box.y + bb.y + bb.height / 2 }
          : null,
        title: g.querySelector('title')?.textContent ?? '',
        texts: [...g.querySelectorAll('text')].map(t => {
          const b = t.getBBox()
          return {
            text: t.textContent, x: +t.getAttribute('x'), y: +t.getAttribute('y'), fill: res(t.getAttribute('fill')),
            box: { x: b.x, y: b.y, w: b.width, h: b.height },
          }
        }),
      })
    }
  }
  return cards
})
const taskCards = anatomy.filter(c => !c.terminal)

const WHITE = 'rgb(255, 255, 255)'
const notWhite = taskCards.filter(c => c.fill !== '#ffffff' && c.fill !== WHITE || !isGrey(c.border))
check('every task card is a white card with a grey border', notWhite.length === 0,
  notWhite.map(c => `${c.node}:${c.fill}/${c.border}`).join('; '))

const badRows = taskCards.filter((c) => {
  const ys = c.texts.map(t => t.y)
  const ordered = ys.every((y, i) => i === 0 || y > ys[i - 1])
  const numLeft = c.texts[0].text.startsWith('n') && Math.abs(c.texts[0].x - (c.cardX + 10)) < 0.6
  return !ordered || !numLeft
})
check('rows run 编号 → 执行者 → 任务内容, top to bottom', badRows.length === 0,
  badRows.length ? badRows.map(c => `${c.node}:${c.texts.map(t => t.text).join(' / ')}`).join('; ') : `${taskCards.length} cards`)

const badIcon = taskCards.filter(c => !c.icon || !c.iconBox
  || c.iconBox.right > c.cardX + c.cardW - 9
  || c.iconBox.left < c.cardX + c.cardW / 2
  || Math.abs(c.iconBox.centerY - (c.texts[0].y - 3.5)) > 3)
check('the status icon sits at the right end of row 1, level with the 编号', badIcon.length === 0,
  badIcon.map(c => `${c.node}:${c.icon} box=${JSON.stringify(c.iconBox)}`).join('; '))

const wrongGlyph = taskCards.filter(c => c.icon !== ICON_OF[stateOf(c)])
check('each state wears its own glyph (就绪↻ 完成绿盘✓ 失败✕ 跳过— 未就绪○ 阻塞⊘)', wrongGlyph.length === 0,
  wrongGlyph.map(c => `${c.node}[${stateOf(c)}]:${c.icon}`).join('; '))
check('all six state glyphs appear across the fixtures',
  new Set(taskCards.map(c => c.icon)).size === 6,
  [...new Set(taskCards.map(c => c.icon))].join(', '))

const wordOnCard = taskCards.filter(c => c.texts.some(t => STATUS_WORDS.some(w => t.text.includes(w))))
check('the status word left the card (the glyph carries it) and moved into the tooltip',
  wordOnCard.length === 0 && taskCards.every(c => STATUS_WORDS.some(w => c.title.includes(w))),
  wordOnCard.length ? wordOnCard.map(c => c.node).join(', ') : 'tooltips carry the word')

// Hue: cards, borders, words, edges and anchors stay greyscale. The only colour
// in the view is on the two status glyphs that need to be found at a glance.
const surfaceHues = new Set()
for (const c of anatomy) {
  for (const v of [c.border, ...c.texts.map(t => t.fill)]) if (v && !isGrey(v)) surfaceHues.add(v.toLowerCase())
}
check('cards, borders and words carry no hue at all', surfaceHues.size === 0, `colours: ${[...surfaceHues].join(', ') || 'none'}`)

const glyphHues = new Set()
for (const c of anatomy) for (const v of c.iconInk) if (v && !isGrey(v)) glyphHues.add(v.toLowerCase())
const hueOk = [...glyphHues].every(h => h === DONE_GREEN || h === FAILED_RED)
  && anatomy.filter(c => c.iconInk.includes(DONE_GREEN)).every(c => stateOf(c) === 'completed')
  && anatomy.filter(c => c.iconInk.includes(FAILED_RED)).every(c => stateOf(c) === 'failed')
  && taskCards.some(c => stateOf(c) === 'completed') && taskCards.some(c => stateOf(c) === 'failed')
check('the only hues are the two status glyphs: 完成绿盘 and 失败砖红', hueOk && glyphHues.size === 2,
  `glyph colours: ${[...glyphHues].join(', ')}`)

const greyOk = taskCards.every(c => c.texts.every(t => isGrey(t.fill)))
const numVsWho = taskCards.every(c => lum(c.texts[0].fill) <= lum(c.texts[1].fill) + 1)
check('ink follows importance: 编号 darker than 执行者, all titles greyscale',
  greyOk && numVsWho,
  taskCards.map(c => `${c.node}:${c.texts[0].fill}>${c.texts[1].fill}`).join(' '))

// Contrast, not vibes: 任务内容 has to clear AA (4.5:1 on white) while the node
// is in play, and may recede once it has settled — but never into the paper.
const contrast = (col) => {
  const c = parseCol(col)
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const L = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  return 1.05 / (L + 0.05)
}
const byState = {}
for (const c of taskCards) byState[stateOf(c)] = contrast(c.texts[2].fill)
const WORK = ['ready', 'pending', 'failed']
check('任务内容 clears AA while the node is in play, and stays visible once settled',
  WORK.every(s => (byState[s] ?? 99) >= 4.5) && Object.values(byState).every(r => r >= 2.2),
  Object.entries(byState).map(([s, r]) => `${s} ${r.toFixed(1)}:1`).join(', '))

// The four rows share 150×72: rows must not collide with each other, and the
// glyph must own its end of row 1 without touching the 编号.
const hits = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
const collisions = []
for (const c of taskCards) {
  for (let i = 0; i < c.texts.length; i++) {
    for (let j = i + 1; j < c.texts.length; j++) {
      if (hits(c.texts[i].box, c.texts[j].box)) collisions.push(`${c.node}:"${c.texts[i].text}"×"${c.texts[j].text}"`)
    }
    if (c.iconBox && hits(c.texts[i].box, { x: c.iconBox.left, y: c.iconBox.centerY - 6, w: c.iconBox.right - c.iconBox.left, h: 12 })) {
      collisions.push(`${c.node}:"${c.texts[i].text}"×${c.icon}`)
    }
  }
}
check('rows and the status glyph never collide inside a card', collisions.length === 0,
  collisions.slice(0, 4).join('; ') || `${taskCards.length} cards measured`)

const readyCards = taskCards.filter(c => stateOf(c) === 'ready')
const readyLum = Math.min(...readyCards.map(c => lum(c.texts[2].fill)))
check('the node in flight is the darkest card in the graph', readyCards.length > 0
  && taskCards.filter(c => stateOf(c) !== 'ready').every(c => lum(c.texts[2].fill) > readyLum),
  `ready ${readyLum} vs next ${Math.min(...taskCards.filter(c => stateOf(c) !== 'ready').map(c => lum(c.texts[2].fill)))}`)

// ── 执行者 shows the expert NAME, never the id (user feedback 2026-09-16) ──
// The plan stores IDs, so this is only true if the id → name resolution ran —
// through the real bridge + cache, which is why the harness stubs electronAPI
// and calls ensureCache() instead of injecting names.
const assigneeRow = (c) => c.texts[1].text
const byKey = Object.fromEntries(taskCards.map(c => [`${c.container}:${c.node}`, c]))
const EXPECTED_WHO = {
  'mid:n2': '@产品专家', 'mid:n4': '@前端专家', 'mid:n5': '@后端专家', 'mid:n7': '@产品专家',
  'mid:n1': '通用子代理', 'mid:n3': '通用子代理', 'mid:n6': '通用子代理',
  // The long one is the point of the fixture: the row holds 13 CJK glyphs at
  // the 12px canvas floor (156px of the 160px inner width), so 15 units clip
  // to 12 + … — exact equality here also proves the clip moved with the font
  // size (the 2026-10-10 Windows-clarity raise), not just the font size.
  'fresh:n2': '@技术文档编写与知识库运…', 'chain:n1': '通用子代理',
}
const wrongWho = Object.entries(EXPECTED_WHO).filter(([k, want]) => byKey[k] && assigneeRow(byKey[k]) !== want)
const idLeak = taskCards.filter(c => /exp_/.test(assigneeRow(c)))
// The widest fixture name, measured: how much of the row it eats and how much
// clearance it leaves. A name that fits only because the row grew is exactly
// what 「名字展示不完整」 asked for, so report the numbers rather than the verdict.
const widest = byKey['fresh:n2']
const widestFit = widest
  ? `widest=${(widest.texts[1].box.w).toFixed(0)}px in ${widest.cardW}px, ${(widest.cardX + widest.cardW - widest.texts[1].box.x - widest.texts[1].box.w).toFixed(0)}px clear`
  : 'widest=n/a'
check('执行者 renders the expert name, not the stored id',
  wrongWho.length === 0 && idLeak.length === 0,
  wrongWho.length || idLeak.length
    ? `wrong: ${wrongWho.map(([k, w]) => `${k}=${assigneeRow(byKey[k])}≠${w}`).join(', ')} leaked: ${idLeak.map(c => assigneeRow(c)).join(', ')}`
    : `${Object.entries(EXPECTED_WHO).slice(0, 4).map(([k]) => `${k}=${assigneeRow(byKey[k])}`).join(' ')}; ${widestFit}`)

// ── Header: two lines by default, expandable when there is more ──
const headState = () => page.evaluate(() => {
  const el = document.querySelector('#head [data-objective]')
  const btn = document.querySelector('#head [data-objective-toggle]')
  const mid = document.querySelector('#mid [data-objective]')
  const midBtn = document.querySelector('#mid [data-objective-toggle]')
  const read = (e) => e && ({
    clamp: getComputedStyle(e).webkitLineClamp,
    client: e.clientHeight,
    scroll: e.scrollHeight,
    text: (e.textContent || '').slice(0, 10),
  })
  return {
    head: read(el), headBtn: btn ? btn.textContent : null, mid: read(mid), midBtn: midBtn ? midBtn.textContent : null,
    headBox: el ? el.getBoundingClientRect().height : 0,
  }
})
const before = await headState()
check('[head] a long objective clamps to exactly two lines and offers 展开',
  before.head?.clamp === '2' && Math.abs(before.head.client - 36) < 1
    && before.head.scroll > before.head.client + 1 && before.headBtn === '展开',
  `clamp=${before.head?.clamp} client=${before.head?.client} scroll=${before.head?.scroll} toggle=${before.headBtn}`)

await page.locator('#head [data-objective-toggle]').click()
await page.waitForTimeout(80)
const after = await headState()
check('[head] clicking 展开 shows the whole objective and offers 收起',
  after.head?.clamp === 'none' && after.head.client > before.head.client
    && after.head.client >= after.head.scroll - 1 && after.headBtn === '收起'
    && after.headBox > before.headBox,
  `clamp=${after.head?.clamp} client=${after.head?.client} (was ${before.head?.client}) scroll=${after.head?.scroll} toggle=${after.headBtn}`)

await page.locator('#head [data-objective-toggle]').click()
await page.waitForTimeout(80)
const collapsed = await headState()
check('[head] clicking 收起 clamps it back to two lines',
  collapsed.head?.clamp === '2' && Math.abs(collapsed.head.client - 36) < 1 && collapsed.headBtn === '展开',
  `clamp=${collapsed.head?.clamp} client=${collapsed.head?.client} toggle=${collapsed.headBtn}`)

check('[mid] a short objective gets no toggle at all',
  before.midBtn === null && before.mid?.clamp === '2' && before.mid.client === before.mid.scroll,
  `toggle=${before.midBtn} client=${before.mid?.client} scroll=${before.mid?.scroll}`)

// Skip-level edges must exist and never share a lane.
const overMid = facts.mid.edges.filter(e => e.over)
const lanes = new Set(overMid.map(e => e.lane))
check('[mid] over edges exist and ride distinct lanes',
  overMid.length >= 3 && lanes.size === overMid.length,
  `${overMid.length} over edges, ${lanes.size} distinct lanes`)

// The in-flight node is the only moving thing, and it moves by SPINNING its
// glyph — the card border is deliberately still (user ruling 2026-09-16).
const spin1 = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('#mid g[data-node] [data-icon="spinner"]')]
    .map((g) => g.closest('g[data-node]').dataset.node)
  const rot = document.querySelector('#mid [data-icon="spinner"] .pm-spin')
  const borderAnimated = [...document.querySelectorAll('#mid g[data-node] rect')]
    .filter((r) => getComputedStyle(r).animationName !== 'none').length
  return {
    ids,
    transform: rot ? getComputedStyle(rot).transform : null,
    // Rotation must be about the glyph's own centre, or the arc wobbles.
    origin: rot ? getComputedStyle(rot).transformOrigin : null,
    borderAnimated,
  }
})
await page.waitForTimeout(320)
const spin2 = await page.evaluate(() => {
  const rot = document.querySelector('#mid [data-icon="spinner"] .pm-spin')
  const b = rot?.getBBox()
  return {
    transform: rot ? getComputedStyle(rot).transform : null,
    origin: rot ? getComputedStyle(rot).transformOrigin : null,
    box: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
  }
})
// Spinning in place needs two things: the group's box symmetric about its own
// origin (why the track circle shares the rotating group), and the CSS origin
// sitting at that box's middle (fill-box, not the viewBox corner).
const originOk = (() => {
  const m = /^([-\d.]+)px ([-\d.]+)px$/.exec(spin2.origin ?? '')
  const b = spin2.box
  if (!m || !b) return false
  const symmetric = Math.abs(b.x + b.w / 2) < 0.01 && Math.abs(b.y + b.h / 2) < 0.01
  return symmetric && Math.abs(+m[1] - b.w / 2) < 0.1 && Math.abs(+m[2] - b.h / 2) < 0.1
})()
check('[mid] the in-flight nodes spin a loading glyph in place, and no card border animates',
  spin1.ids.length === 2 && spin1.ids.every(id => ['n2', 'n3'].includes(id))
    && spin1.borderAnimated === 0
    && spin1.transform !== null && spin1.transform !== spin2.transform && originOk,
  `spinning: [${spin1.ids.join(', ')}], transform ${spin1.transform} → ${spin2.transform}, origin ${spin2.origin} of box ${JSON.stringify(spin2.box)}, animated borders: ${spin1.borderAnimated}`)

// ── Node click (PLAN-workbench W12) ──
// A real mouse onto each card: the reported bug was a click that reached
// nothing at all, so what is asserted is the handler being called with the node
// the user aimed at — and that a node which can open *something* is the one
// dressed as clickable. Which target that turns into is not this component's
// call (App's resolvePlanNodeTarget decides, unit-tested in
// tests/plan-node-target.test.ts).
await page.waitForSelector('#click [data-node="n1"]', { timeout: 10000 })
await page.evaluate(() => { window.__clicks = [] })
for (const nodeId of ['n1', 'n2']) {
  await page.locator(`#click g[data-node="${nodeId}"]`).click()
}
const clicks = await page.evaluate(() => window.__clicks)
check('[click] a real click on each card reaches onOpenPlanNode with its node id',
  JSON.stringify(clicks) === JSON.stringify([['open', 'n1'], ['open', 'n2']]),
  JSON.stringify(clicks))

const cursorFor = async (nodeId) => page.evaluate((id) => {
  const rect = document.querySelector(`#click g[data-node="${id}"]`)
  return getComputedStyle(rect).cursor
}, nodeId)
const cursors = {
  linked: await cursorFor('n1'),
  settled: await cursorFor('n2'),
  dead: await cursorFor('n3'),
}
check('[click] only nodes that can open something show a pointer cursor',
  cursors.linked === 'pointer' && cursors.settled === 'pointer' && cursors.dead === 'default',
  `linked=${cursors.linked} settled=${cursors.settled} dead=${cursors.dead}`)

const hints = await page.evaluate(() =>
  [...document.querySelectorAll('#click g[data-node]')].map(g => [g.dataset.node, g.querySelector('title')?.textContent || '']))
const hintOf = (id) => hints.find(h => h[0] === id)[1]
check('[click] the tooltip promises a jump only where a click lands',
  hintOf('n1').includes('点击查看子代理会话')
    && hintOf('n2').includes('点击查看子代理会话')
    && !hintOf('n3').includes('点击'),
  hints.map(h => `${h[0]}:${h[1].split('\n').pop() || '(no hint)'}`).join(' | '))

// The 开始/结束 pills are scaffolding, not targets — clicking one must not jump.
await page.evaluate(() => { window.__clicks = [] })
await page.locator('#click g[data-node="__start__"]').click()
await page.waitForTimeout(80)
const afterAnchor = await page.evaluate(() => window.__clicks)
check('[click] the 开始/结束 anchors are not click targets', afterAnchor.length === 0, JSON.stringify(afterAnchor))

// ── Report expression surface (PLAN-plan-exchange B3 前半) ──
// 声明状态可对照 + 报告可打开：徽标只画在能和验收词读出落差的地方，链接
// 长在每张带报告的卡上，且链接的点击只是报告的（卡片背后的会话下钻必须
// 保持沉默——stopPropagation 是这条信封的一半）。
await page.waitForSelector('#report [data-node="n1"]', { timeout: 10000 })
const reportTexts = await page.evaluate(() => {
  const out = {}
  for (const g of document.querySelectorAll('#report g[data-node]')) {
    out[g.dataset.node] = [...g.querySelectorAll('text')].map(t => t.textContent)
  }
  return out
})
check('[report] a partial declaration chips the completed card; success does not chip',
  reportTexts.n1.includes('部分成功') && !reportTexts.n1.includes('声明失败')
    && !reportTexts.n2.includes('部分成功') && !reportTexts.n2.includes('声明失败'),
  JSON.stringify(reportTexts))
check('[report] every report-bearing card carries the 查看报告 link',
  reportTexts.n1.includes('查看报告') && reportTexts.n2.includes('查看报告'),
  JSON.stringify(reportTexts))

const reportBoxes = await page.evaluate(() => {
  const rows = []
  for (const g of document.querySelectorAll('#report g[data-node]')) {
    const r = g.querySelector('rect')
    const rect = { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }
    for (const t of g.querySelectorAll('text')) {
      const b = t.getBBox()
      rows.push({ node: g.dataset.node, text: (t.textContent || '').slice(0, 6),
        left: +(b.x - rect.x).toFixed(1), over: +(b.x + b.width - (rect.x + rect.w)).toFixed(1) })
    }
  }
  return rows
})
const chipBox = reportBoxes.find(r => r.node === 'n1' && r.text === '部分成功')
const linkBoxes = reportBoxes.filter(r => r.text === '查看报告')
check('[report] chip and links sit INSIDE their card with margin',
  !!chipBox && chipBox.left >= 2 && chipBox.over <= 0
    && linkBoxes.length === 2 && linkBoxes.every(l => l.left >= 2 && l.over <= -2),
  JSON.stringify({ chipBox, linkBoxes }))

// Row 2 shares its line between the assignee and the link — measured bboxes,
// because the clip exists precisely so the two never touch.
const row2 = await page.evaluate(() => {
  const g = document.querySelector('#report g[data-node="n1"]')
  const top = +g.querySelector('rect').getAttribute('y')
  const boxes = [...g.querySelectorAll('text')]
    .map(t => ({ text: t.textContent || '', b: t.getBBox() }))
    .filter(x => x.b.y + x.b.height / 2 > top + 20 && x.b.y + x.b.height / 2 < top + 40)
    .sort((a, b) => a.b.x - b.b.x)
  let minGap = Infinity
  for (let i = 1; i < boxes.length; i++) {
    minGap = Math.min(minGap, +(boxes[i].b.x - (boxes[i - 1].b.x + boxes[i - 1].b.width)).toFixed(1))
  }
  return { texts: boxes.map(x => x.text), minGap }
})
check('[report] row 2: the link never touches the (clipped) assignee text',
  row2.texts.includes('查看报告') && row2.minGap >= 4,
  JSON.stringify(row2))

const reportHints = await page.evaluate(() => {
  const out = {}
  for (const g of document.querySelectorAll('#report g[data-node]')) {
    out[g.dataset.node] = g.querySelector('title')?.textContent || ''
  }
  return out
})
check('[report] the tooltip carries the declared state and names the report affordance',
  reportHints.n1.includes('声明 部分成功') && reportHints.n1.includes('点击「查看报告」打开交付报告')
    && reportHints.n2.includes('声明 成功') && reportHints.n2.includes('点击「查看报告」打开交付报告'),
  JSON.stringify(reportHints))

// A real mouse on the link: the report opens, the card's session click stays
// out of it (stopPropagation), and a pan that crossed the threshold would
// swallow it like any card click (covered by the canvas D3 guard above).
await page.evaluate(() => { window.__clicks = [] })
await page.locator('#report').scrollIntoViewIfNeeded()
await page.waitForTimeout(120)
await page.locator('#report g[data-node="n1"] text.pm-node-report').click()
await page.waitForTimeout(80)
const reportClicks = await page.evaluate(() => window.__clicks)
check('[report] clicking 查看报告 opens the report — and not the session behind it',
  JSON.stringify(reportClicks) === JSON.stringify([['report', 'n1']]),
  JSON.stringify(reportClicks))

// ── Drill-in highlight (查看子代理会话时面板对应模块高亮) ──
// The card the sub-agent session view is open on wears the accent ink the
// report link already carries on these cards (--pm-link / --pm-link-bg);
// everything else — dash, glyph, ink ladder, sibling cards — stays untouched,
// and a closed drill-in paints no accent at all.
await page.waitForSelector('#highlight [data-node="n2"]', { timeout: 10000 })
const highlightFacts = await page.evaluate(() => {
  const res = (raw) => {
    if (!raw || raw.indexOf('var(') < 0) return raw
    const d = document.createElement('div')
    d.style.color = raw
    document.body.appendChild(d)
    const v = getComputedStyle(d).color
    d.remove()
    return v
  }
  const cards = [...document.querySelectorAll('#highlight g[data-node]')]
    .filter((g) => !g.dataset.node.startsWith('__'))
    .map((g) => {
      const r = g.querySelector('rect')
      return {
        node: g.dataset.node,
        marked: g.dataset.highlighted === 'true',
        stroke: res(r.getAttribute('stroke')),
        fill: res(r.getAttribute('fill')),
        title: g.querySelector('title')?.textContent ?? '',
      }
    })
  return { cards, linkInk: res('var(--pm-link)'), linkTint: res('var(--pm-link-bg)') }
})
const hlCard = highlightFacts.cards.find((c) => c.node === 'n2')
const hlSiblings = highlightFacts.cards.filter((c) => c.node !== 'n2')
check('[highlight] exactly the viewed node carries the mark, one card at most',
  hlCard?.marked === true && hlSiblings.every((c) => !c.marked) && highlightFacts.cards.length === 3,
  JSON.stringify(highlightFacts.cards.map((c) => [c.node, c.marked])))
check('[highlight] the highlighted card wears the link ink over the link tint',
  hlCard?.stroke === highlightFacts.linkInk && hlCard?.fill === highlightFacts.linkTint,
  `stroke=${hlCard?.stroke} vs ${highlightFacts.linkInk}; fill=${hlCard?.fill} vs ${highlightFacts.linkTint}`)
check('[highlight] sibling cards keep the grey sheet (white fill, grey stroke)',
  hlSiblings.every((c) => (c.fill === '#ffffff' || c.fill === 'rgb(255, 255, 255)') && isGrey(c.stroke)),
  hlSiblings.map((c) => `${c.node}:${c.fill}/${c.stroke}`).join('; '))
check('[highlight] the tooltip names what is being viewed',
  !!hlCard && hlCard.title.includes('正在查看该模块的子代理会话'),
  hlCard?.title)
const noHl = await page.evaluate(() => ({
  marked: document.querySelectorAll('#nohighlight [data-highlighted]').length,
  fills: [...document.querySelectorAll('#nohighlight g[data-node] rect')]
    .filter((r) => !r.closest('g[data-node]').dataset.node.startsWith('__'))
    .map((r) => r.getAttribute('fill')),
}))
check('[nohighlight] a closed drill-in paints no accent and no tinted fill',
  noHl.marked === 0 && noHl.fills.every((f) => f === 'var(--pm-elevated)'),
  JSON.stringify(noHl))


// ── Canvas (PLAN-plan-graph-canvas M4): 100% floor + drag-to-scroll + click
// guard + reset — all with a real pointer, never dispatched events. ──
const cvBox = page.locator('#canvas')
const cvViewport = cvBox.locator('[data-graph-viewport]')
await cvViewport.waitFor()
// The canvas fixture sits below the fold in the flex-wrap wall of mounts —
// pointer events at off-viewport coordinates are silently dropped.
await cvBox.scrollIntoViewIfNeeded()
await page.waitForTimeout(120)

// ① Narrow pane renders at 100%: the first card is its native 180px wide and
// the description text keeps its native 11.5px. (Reverting MIN_PLAN_SCALE to
// 0.55 fails exactly here.)
await cvBox.locator('g[data-node="n1"] rect').scrollIntoViewIfNeeded()
const n1box = await cvBox.locator('g[data-node="n1"] rect').boundingBox()
const n1attr = await cvBox.locator('g[data-node="n1"] rect').evaluate((el) => ({
  w: el.getAttribute('width'),
  bbox: el.getBoundingClientRect().width,
  svgScale: el.ownerSVGElement.getBoundingClientRect().width / +el.ownerSVGElement.getAttribute('width'),
}))
const descFont = await cvBox.locator('g[data-node="n1"] text').filter({ hasText: '调研竞品' }).first().evaluate((el) => getComputedStyle(el).fontSize)
check('[canvas] a 300px pane renders cards at native 180px at scale 1 (100% floor, D1)',
  n1attr.w === '180' && Math.abs(n1attr.bbox - 180) < 0.5 && Math.abs(n1attr.svgScale - 1) < 0.01,
  `attr=${n1attr.w} bbox=${n1attr.bbox?.toFixed(1)} svgScale=${n1attr.svgScale.toFixed(3)}`)
check('[canvas] card text keeps its native 12px size', descFont === '12px', descFont)

// ② Drag from a blank corner pans the canvas exactly with the pointer (D2).
const vpBox = await cvViewport.boundingBox()
const scrollBefore = await cvViewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
const maxScroll = await cvViewport.evaluate((el) => ({ left: el.scrollWidth - el.clientWidth, top: el.scrollHeight - el.clientHeight }))
await page.mouse.move(vpBox.x + 12, vpBox.y + 14)
await page.mouse.down()
await page.mouse.move(vpBox.x + 12 - 120, vpBox.y + 14 - Math.min(60, maxScroll.top - scrollBefore.top - 2), { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(80)
const scrollAfterDrag = await cvViewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
const dragDx = scrollAfterDrag.left - scrollBefore.left
check('[canvas] dragging 120px pans scrollLeft by exactly 120 (D2)',
  Math.abs(dragDx - 120) < 1.5, `ΔscrollLeft=${dragDx.toFixed(1)} (max ${maxScroll.left})`)
check('[canvas] vertical drag pans scrollTop too', scrollAfterDrag.top > scrollBefore.top,
  `${scrollBefore.top} → ${scrollAfterDrag.top} (max ${maxScroll.top})`)

// ③ Drag that starts ON a card pans AND swallows the click that would follow (D3).
await page.evaluate(() => { window.__canvasClicks = [] })
const cardCenter = { x: n1box.x + n1box.width / 2, y: n1box.y + n1box.height / 2 }
const scrollPre3 = await cvViewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
await page.mouse.move(cardCenter.x, cardCenter.y)
await page.mouse.down()
await page.mouse.move(cardCenter.x - 90, cardCenter.y - 40, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(100)
const scrollPost3 = await cvViewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
const clicks3 = await page.evaluate(() => window.__canvasClicks)
// Direction-agnostic: dragging left/up MUST grow the scroll offsets by the
// drag distance (scroll moves opposite to the pointer).
check('[canvas] a card-originated drag pans the canvas',
  Math.abs(scrollPost3.left - scrollPre3.left) >= 50 || Math.abs(scrollPost3.top - scrollPre3.top) >= 40,
  `${JSON.stringify(scrollPre3)} → ${JSON.stringify(scrollPost3)}`)
check('[canvas] the drag swallows the node click that follows it (D3)', clicks3.length === 0, JSON.stringify(clicks3))
// Deleting the swallow guard fails exactly this check.

// ④ Press and release WITHOUT moving wherever the pointer now sits: that is
// a click, not a drag — and it opens whatever node is under it (the pan from
// ③ may have moved a different card under the pointer; WHICH node is
// irrelevant, the point is that the click was NOT swallowed).
await page.mouse.move(cardCenter.x, cardCenter.y)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(100)
const clicks4 = await page.evaluate(() => window.__canvasClicks)
check('[canvas] a stationary press on a card still opens the node (D3)', clicks3.length === 0 && clicks4.length === 1, JSON.stringify(clicks4))

// ⑤ The reset button exists only when the graph overflows, and returns the view.
const hasReset = await cvBox.locator('[data-graph-reset]').count()
check('[canvas] the reset button appears for an overflowing graph (D5)', hasReset === 1, `count=${hasReset}`)
const noResetZoom = await page.locator('#zoom [data-graph-reset]').count()
check('[canvas] a fitting graph renders no reset button (D5)', noResetZoom === 0, `count=${noResetZoom}`)
await cvBox.locator('[data-graph-reset]').click()
await page.waitForTimeout(80)
const scrollReset = await cvViewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
check('[canvas] reset returns the view to the initial position', scrollReset.left === 0 && scrollReset.top === 0, JSON.stringify(scrollReset))

for (const id of ['mid', 'fresh', 'chain']) {
  await page.locator(`#${id}`).screenshot({ path: join(SHOTS, `plan-${id}.png`) })
}
await page.locator('#click').screenshot({ path: join(SHOTS, 'plan-click.png') })
await page.locator('#highlight').screenshot({ path: join(SHOTS, 'plan-highlight.png') })
// The full-size shot is only worth looking at if it really is 1:1 — one CSS
// pixel per layout unit here, rendered into the PNG at deviceScaleFactor 2.
const zoomScale = await page.evaluate(() => {
  const rect = document.querySelector('#zoom g[data-node]:not([data-node^="__"]) rect')
  return rect.getBoundingClientRect().width / +rect.getAttribute('width')
})
check('the full-size screenshot renders the cards at scale 1 (PNG is 2× those pixels)',
  Math.abs(zoomScale - 1) < 0.02, `measured ${zoomScale.toFixed(3)}× auto-scale`)
await page.locator('#zoom').screenshot({ path: join(SHOTS, 'plan-cards-fullsize.png') })
writeFileSync(join(SHOTS, 'results.json'), JSON.stringify(results, null, 2))

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots: ${SHOTS}`)
await browser.close()
if (failed.length > 0) process.exit(1)
