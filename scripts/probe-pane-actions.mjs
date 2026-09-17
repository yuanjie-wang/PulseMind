/**
 * Browser pane action probe (real main-process BrowserService, real database).
 *
 * The workbench's 浏览器 tab can be opened before any tab exists, and in that
 * state the address bar is the ONLY way to say where to go — it is also the one
 * state the DOM probe cannot follow past the IPC boundary. This probe drives the
 * real service to pin what happens to a `navigate` that carries no `tabId`
 * (the pane had no tab): it must open a tab and go there, which is exactly what
 * the address bar's placeholder promises.
 *
 * Everything except the app-view backend is production code: the dispatch, the
 * per-conversation scope resolution, the pane bookkeeping, the audit rows and
 * the pane update pushed back to the renderer. The backend registry is replaced
 * with a fake because a real tab is a WebContentsView inside an app window
 * driven over CDP — no window, no port here. The `newTab`/`navigate` bookkeeping
 * that a real tab would exercise is the part under test.
 *
 * Runs like scripts/probe-project-color-db.mjs: esbuild bundles the real modules
 * (`electron` aliased to a stub, since `require('electron')` outside a running
 * app returns a *string*), the Electron binary executes the bundle in
 * `ELECTRON_RUN_AS_NODE` mode so better-sqlite3's Electron-ABI binding loads,
 * and `HOME` points at a fresh temp dir — the guard below refuses to touch
 * anything outside it, so the user's real ~/.pulsemind is never opened.
 *
 * Usage: node scripts/probe-pane-actions.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE

const SCOPE_A = 'conv_pane_a'
const SCOPE_B = 'conv_pane_b'
const SCOPE_C = 'conv_pane_c'
const SCOPE_D = 'conv_pane_d'
const SCOPE_E = 'conv_pane_e'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

/** Replacement for the app-view backend: records what the service asks of it.
 *  `currents` is what a real page.url()/webContents.getURL() would report —
 *  the T4.3 fold reads getURL, so the fake view must follow navigations. */
function fakeAppView(dockCalls) {
  const created = []
  const navigations = []
  const views = new Map()
  const currents = new Map()
  return {
    created,
    navigations,
    currentUrl: (tabId) => currents.get(tabId) ?? '',
    descriptor: () => ({ id: 'app-view', type: 'app-view', capabilities: { browser: ['open', 'tabs', 'user'], tab: ['navigate'] } }),
    async start() {},
    async stop() {},
    async newTab({ tabId, origin, scopeId, url }) {
      created.push({ tabId, origin, scopeId, url: url ?? null })
      currents.set(tabId, url ?? 'about:blank') // a real page.url() follows navigations
      return {
        page: {
          url: () => currents.get(tabId) ?? '',
          title: async () => '',
          goto: async (target) => {
            navigations.push({ tabId, url: target })
            currents.set(tabId, target)
            return null
          },
          goBack: async () => {},
          goForward: async () => {},
          reload: async () => {},
        },
        close: async () => {},
      }
    },
    // One stable fake view per tab, so the dock's mounting decisions are
    // observable: addChildView must fire once per view, never per switch.
    viewOf: (tabId) => {
      if (!views.has(tabId)) {
        views.set(tabId, {
          setBounds: (b) => dockCalls.bounds.push({ tabId, w: b.width }),
          webContents: { setZoomFactor: () => {}, getURL: () => currents.get(tabId) ?? '', getTitle: () => '' },
        })
      }
      return views.get(tabId)
    },
    async claimTab() {},
  }
}

/** The renderer's side of the wire: the pane snapshots main pushes back. */
function fakeSender(sink) {
  return {
    send: (_channel, update) => sink.push(update),
    isDestroyed: () => false,
  }
}

async function phaseRun() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!DATA_DIR.startsWith(home)) throw new Error(`DATA_DIR ${DATA_DIR} is outside PM_HOME ${home} — refusing to touch it`)
  ensureDataDir()
  const { initializeDatabase } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { auditStore } = await import('../src/main/storage/audit-store')
  const { BrowserService } = await import('../src/main/browser/BrowserService')

  const { browserHistoryStore } = await import('../src/main/storage/browser-history-store')
  // query('') is the recency feed since T4.2 — the whole table, newest first.
  const allRows = () => browserHistoryStore.query('', 500)

  const service = new BrowserService()
  await new Promise((r) => setTimeout(r, 50)) // loadDefaults settles
  // The REAL dock, fed a fake window so its mounting decisions are countable
  // (PLAN-browser-pane-ux T1.4): addChildView/removeChildView must not grow
  // with tab switches — a persistent mount + bounds writes is the whole fix.
  const dockCalls = { add: 0, remove: 0, bounds: [] }
  const { appViewDock } = await import('../src/main/browser/app-view-dock')
  appViewDock.attach({
    contentView: {
      addChildView: () => { dockCalls.add += 1 },
      removeChildView: () => { dockCalls.remove += 1 },
    },
    getContentSize: () => [1400, 900],
    on: () => {},
    webContents: { isDestroyed: () => false, send: (_c, u) => updatesSink.push(u) },
  })
  const backend = fakeAppView(dockCalls)
  service.backends.set('app-view', backend)
  // backendFor wires this on the real AppViewBackend; the pre-set fake gets
  // the same hook so section 9 can fire it by hand.
  backend.onTabActivity = () => service.handleTabActivity()

  const updatesSink = []
  const updates = updatesSink
  const sender = fakeSender(updates)
  const paneState = (conversationId) => ({
    viewKind: 'chat',
    conversationId,
    chatAreaWidth: 1300,
    browserActive: true,
  })
  const lastUpdate = () => updates[updates.length - 1]
  const tabsOf = (scope) => backend.created.filter((t) => t.scopeId === scope)

  /* ── 1. The "+" button ───────────────────────────────────────────────── */
  service.handlePaneState(paneState(SCOPE_A), sender)
  await service.handlePaneAction({ op: 'newTab' }, sender)
  const aTabs = tabsOf(SCOPE_A)
  check('the "+" button opens exactly one tab', aTabs.length === 1, JSON.stringify(aTabs))
  check('…and it is the pane\'s own tab, not an agent tab', aTabs[0]?.origin === 'user', String(aTabs[0]?.origin))
  check('…and it becomes the active tab the chrome renders', lastUpdate()?.tabs?.length === 1 && lastUpdate().tabs[0].active === true, JSON.stringify(lastUpdate()?.tabs))
  check('…and the pane reports itself visible', lastUpdate()?.visible === true, String(lastUpdate()?.visible))

  /* ── 2. An address typed with a tab open ─────────────────────────────── */
  await service.handlePaneAction({ op: 'navigate', tabId: aTabs[0].tabId, url: 'example.com' }, sender)
  check(
    'an address typed with a tab open goes to THAT tab, scheme completed',
    backend.navigations.length === 1 && backend.navigations[0].tabId === aTabs[0].tabId && backend.navigations[0].url === 'https://example.com/',
    JSON.stringify(backend.navigations),
  )
  check('…without opening another tab', tabsOf(SCOPE_A).length === 1, `${tabsOf(SCOPE_A).length} tab(s)`)

  /* ── 3. An address typed with no tab at all (the reported bug) ───────── */
  service.handlePaneState(paneState(SCOPE_B), sender)
  await service.handlePaneAction({ op: 'navigate', url: 'mail.163.com' }, sender)
  const bTabs = tabsOf(SCOPE_B)
  check('an address typed with no tab open opens one', bTabs.length === 1, JSON.stringify(bTabs))
  check(
    '…and navigates that new tab to the typed address',
    backend.navigations.length === 2 && backend.navigations[1].tabId === bTabs[0]?.tabId && backend.navigations[1].url === 'https://mail.163.com/',
    JSON.stringify(backend.navigations.slice(1)),
  )
  check(
    '…and the pane update the chrome renders from carries that tab, active',
    lastUpdate()?.conversationId === SCOPE_B && lastUpdate()?.tabs?.length === 1 && lastUpdate().tabs[0].active === true,
    JSON.stringify(lastUpdate()?.tabs),
  )

  // A tab that already exists must be reused, never duplicated: the browser
  // tab's address bar keeps meaning "go there" once there is somewhere to go.
  await service.handlePaneAction({ op: 'navigate', url: 'https://example.org/' }, sender)
  check('a second tab-less navigate reuses the tab it just opened', tabsOf(SCOPE_B).length === 1, `${tabsOf(SCOPE_B).length} tab(s)`)
  check(
    '…and lands on the second address',
    backend.navigations[2]?.url === 'https://example.org/' && backend.navigations[2]?.tabId === bTabs[0].tabId,
    JSON.stringify(backend.navigations[2]),
  )

  /* ── 4. An address main cannot parse ─────────────────────────────────── */
  service.handlePaneState(paneState(SCOPE_C), sender)
  const rejected = await service.handlePaneAction({ op: 'navigate', url: 'https://[bad' }, sender).then(
    () => null,
    (err) => (err instanceof Error ? err.message : String(err)),
  )
  check('an address main cannot parse is rejected', typeof rejected === 'string' && rejected.includes('非法 URL'), JSON.stringify(rejected))
  check('…before any tab is opened for it', tabsOf(SCOPE_C).length === 0, `${tabsOf(SCOPE_C).length} tab(s)`)

  // Scope isolation: a tab id from another conversation must not be drivable.
  const crossScope = await service
    .handlePaneAction({ op: 'navigate', tabId: aTabs[0].tabId, url: 'https://evil.example/' }, sender)
    .then(() => null, (err) => (err instanceof Error ? err.message : String(err)))
  check('another conversation\'s tab cannot be navigated from this one', typeof crossScope === 'string' && crossScope.includes('不属于'), JSON.stringify(crossScope))
  check('…and nothing was navigated by that attempt', !backend.navigations.some((n) => n.url.includes('evil.example')), JSON.stringify(backend.navigations))

  /* ── 5. Switching tabs mounts once and then only re-bounds (T1.4) ────── */
  service.handlePaneState(paneState(SCOPE_D), sender)
  await service.handlePaneAction({ op: 'newTab' }, sender)
  await service.handlePaneAction({ op: 'newTab' }, sender)
  const dTabs = tabsOf(SCOPE_D)
  check('the switch section has two tabs to flip between', dTabs.length === 2, JSON.stringify(dTabs))
  // T4.3: a fresh about:blank tab folds the webview — navigate both so there
  // is something to switch between (the fold section below owns fresh tabs).
  await service.handlePaneAction({ op: 'navigate', tabId: dTabs[0].tabId, url: 'https://d-one.example/' }, sender)
  await service.handlePaneAction({ op: 'navigate', tabId: dTabs[1].tabId, url: 'https://d-two.example/' }, sender)
  // A view mounts on its FIRST SIGHTING, and navigating an inactive tab does
  // not show it — warm both up so the flip loop below really tests "switching
  // mounts nothing", not "the first switch pays the first mount".
  await service.handlePaneAction({ op: 'selectTab', tabId: dTabs[0].tabId }, sender)
  await service.handlePaneAction({ op: 'selectTab', tabId: dTabs[1].tabId }, sender)
  const addAfterCreate = dockCalls.add
  const removeAfterCreate = dockCalls.remove
  for (let i = 0; i < 4; i++) {
    await service.handlePaneAction({ op: 'selectTab', tabId: dTabs[i % 2].tabId }, sender)
  }
  check(
    'four tab switches do not re-mount anything (persistent dock, T1.2)',
    dockCalls.add === addAfterCreate && dockCalls.remove === removeAfterCreate,
    `add ${removeAfterCreate === dockCalls.remove ? dockCalls.add : '?'}→${dockCalls.add}, remove ${removeAfterCreate}→${dockCalls.remove}`,
  )
  check(
    '…the switches travelled through bounds writes instead (both tabs got one)',
    dockCalls.bounds.filter((b) => dTabs.some((t) => t.tabId === b.tabId)).length >= 6,
    JSON.stringify(dockCalls.bounds.slice(-6)),
  )
  // Layout writes the active view's box FIRST and then zeroes everyone else,
  // so the last-per-view write is the state each view ends in.
  const lastWidthByTab = new Map()
  for (const b of dockCalls.bounds) lastWidthByTab.set(b.tabId, b.w)
  const activeId = lastUpdate().tabs.find((t) => t.active)?.id
  check(
    '…the active tab ends non-zero and every other mounted view at zero',
    (lastWidthByTab.get(activeId) ?? 0) > 0 &&
      [...lastWidthByTab.entries()].every(([id, w]) => id === activeId || w === 0),
    JSON.stringify([...lastWidthByTab]),
  )

  /* ── 6. The audit trail says what the user did ───────────────────────── */
  const audit = auditStore.list(100).filter((e) => e.scope === 'browser')
  const newTabRows = audit.filter((e) => e.action === 'browser.paneNewTab')
  const navRows = audit.filter((e) => e.action === 'browser.paneNavigate')
  check(
    'exactly the user-opened tabs are audited (the reused address opened none)',
    newTabRows.length === 4 && new Set(newTabRows.map((e) => e.actor)).size === 3,
    newTabRows.map((e) => `${e.actor}:${e.target}`).join(' '),
  )
  check(
    'every navigation is audited against the completed URL',
    navRows.map((e) => e.target).sort().join(' ') === 'https://d-one.example/ https://d-two.example/ https://example.com/ https://example.org/ https://mail.163.com/',
    navRows.map((e) => e.target).join(' '),
  )
  check(
    'the rejected address never reached the audit log as a navigation',
    !navRows.some((e) => String(e.target).includes('bad')) && !navRows.some((e) => String(e.target).includes('evil')),
    navRows.map((e) => e.target).join(' '),
  )
  /* ── 7. Address-bar history (T3.6): manual navigation only, LRU, clearable ── */
  const manualUrls = ['https://example.com/', 'https://mail.163.com/', 'https://example.org/']
  const histSoFar = manualUrls.map((u) => browserHistoryStore.query(new URL(u).host, 10).find((r) => r.url === u))
  check(
    'every completed manual navigation landed in history, final url',
    histSoFar.every((r) => r && manualUrls.includes(r.url)),
    JSON.stringify(histSoFar),
  )
  check('…with a title snapshot (empty here, null tolerated)', histSoFar.every((r) => r && (r.title === null || typeof r.title === 'string')), JSON.stringify(histSoFar.map((r) => r?.title)))

  const countBefore = histSoFar.filter(Boolean).length
  service.handlePaneState(paneState(SCOPE_B), sender) // section 5 left SCOPE_D active
  await service.handlePaneAction({ op: 'navigate', tabId: bTabs[0].tabId, url: 'https://mail.163.com/' }, sender)
  const mailRow = browserHistoryStore.query('mail.163.com', 10).find((r) => r.url === 'https://mail.163.com/')
  check('re-visiting bumps the visit count instead of inserting a second row', mailRow?.visitCount === 2, JSON.stringify(mailRow))
  check('…and the table still holds exactly one row per url', browserHistoryStore.query('163.com', 50).length === 1, '')

  // The AGENT's navigate (executeCommand) must never write history (裁定 L1).
  const agentNavBefore = histSoFar.length + 1
  await service.executeCommand({ method: 'navigate', url: 'https://agent-visited.example/' }, SCOPE_B)
  const agentRows = browserHistoryStore.query('agent-visited', 10)
  check('an agent-driven navigate writes NO history row (manual navigation only, L1)', agentRows.length === 0, JSON.stringify(agentRows))
  void agentNavBefore

  // Ranking: url-substring rows for 'mail' come back newest-first.
  const ranked = browserHistoryStore.query('mail', 10)
  check('query matches url substrings and orders newest-first', ranked.length >= 1 && ranked[0].url === 'https://mail.163.com/', JSON.stringify(ranked))

  /* ── 8. A fresh (about:blank) tab folds the webview — the renderer's empty
     state owns the area until the tab gains a URL (T4.3) ─────────────────── */
  service.handlePaneState(paneState(SCOPE_E), sender)
  const addBeforeFresh = dockCalls.add
  await service.handlePaneAction({ op: 'newTab' }, sender)
  const eTabs = tabsOf(SCOPE_E)
  check('the fresh tab exists and the chrome lists it active', eTabs.length === 1 && lastUpdate()?.tabs?.length === 1 && lastUpdate().tabs[0].active === true, JSON.stringify(lastUpdate()?.tabs))
  check('…but its view is NOT mounted (folded so the empty state shows)', dockCalls.add === addBeforeFresh, `add ${addBeforeFresh}→${dockCalls.add}`)
  check('…and no non-zero bounds were written for it', !dockCalls.bounds.some((b) => b.tabId === eTabs[0].tabId && b.w > 0), JSON.stringify(dockCalls.bounds.filter((b) => b.tabId === eTabs[0].tabId)))
  await service.handlePaneAction({ op: 'navigate', tabId: eTabs[0].tabId, url: 'https://unfold.example/' }, sender)
  check('navigating the fresh tab mounts its view exactly once', dockCalls.add === addBeforeFresh + 1, `add →${dockCalls.add}`)
  const lastWidthE = new Map()
  for (const b of dockCalls.bounds) lastWidthE.set(b.tabId, b.w)
  check('…and the view ends non-zero (webview visible again)', (lastWidthE.get(eTabs[0].tabId) ?? 0) > 0, JSON.stringify([...lastWidthE.entries()].filter(([id]) => id === eTabs[0].tabId)))

  /* ── 9. An agent navigate bypasses handlePaneAction — the backend's activity
     event must lift the fold (handleTabActivity, T4.3) ────────────────────── */
  await service.executeCommand({ method: 'newTab' }, SCOPE_E)
  const agentTab = tabsOf(SCOPE_E)[1]
  check('the agent opened its own fresh tab', !!agentTab && backend.currentUrl(agentTab.tabId) === 'about:blank', backend.currentUrl(agentTab?.tabId ?? ''))
  await service.handlePaneAction({ op: 'selectTab', tabId: agentTab.tabId }, sender)
  const addBeforeAgent = dockCalls.add
  check('selecting the fresh agent tab keeps the fold', dockCalls.add === addBeforeAgent, `add →${dockCalls.add}`)
  await service.executeCommand({ method: 'navigate', tabId: agentTab.tabId, url: 'https://agent-unfold.example/' }, SCOPE_E)
  check('the agent navigate alone does not lift it (executeCommand never syncs)', dockCalls.add === addBeforeAgent, `add →${dockCalls.add}`)
  backend.onTabActivity()
  check('the activity event lifts the fold (view mounted)', dockCalls.add === addBeforeAgent + 1, `add →${dockCalls.add}`)
  const lastWidth9 = new Map()
  for (const b of dockCalls.bounds) lastWidth9.set(b.tabId, b.w)
  check('…and the agent tab ends non-zero', (lastWidth9.get(agentTab.tabId) ?? 0) > 0, String(lastWidth9.get(agentTab.tabId)))
  check('…and still no history row (L1 again)', browserHistoryStore.query('agent-unfold', 10).length === 0, '')

  /* ── 10. query('') is the recency feed for the empty state's 最近访问 (T4.2) ── */
  browserHistoryStore.recordVisit('https://recents-a.example/', 'A', Date.now() + 1000)
  browserHistoryStore.recordVisit('https://recents-b.example/', 'B', Date.now() + 2000)
  const recents = browserHistoryStore.query('', 5)
  check('empty query returns the most recent rows first', recents[0]?.url === 'https://recents-b.example/' && recents[1]?.url === 'https://recents-a.example/', JSON.stringify(recents.slice(0, 2).map((r) => r.url)))

  // LRU cap: push the table past MAX and the oldest rows fall out. The table
  // holds other rows by now (later sections' navigations), so assert the
  // invariants — cap enforced, oldest flood rows gone, and every row older
  // than the flood evicted — rather than a flood-kept count that depends on
  // how many rows preceded it.
  const { MAX_BROWSER_HISTORY } = await import('../src/main/storage/browser-history-store')
  const base = Date.now()
  const preOldUrls = browserHistoryStore
    .query('', 1000)
    .filter((r) => r.lastVisitAt < base)
    .map((r) => r.url)
  for (let i = 0; i < MAX_BROWSER_HISTORY + 1; i++) {
    browserHistoryStore.recordVisit(`https://flood.example/${i}`, undefined, base + i)
  }
  const kept = browserHistoryStore.query('flood.example', MAX_BROWSER_HISTORY + 10)
  const oldestFlood = browserHistoryStore.query('flood.example/0', 10)
  const newestFlood = browserHistoryStore.query(`flood.example/${MAX_BROWSER_HISTORY}`, 10)
  const total = browserHistoryStore.query('', 2000).length
  const preOldGone = preOldUrls.every((u) => browserHistoryStore.query(u, 10).length === 0)
  check(
    `a ${MAX_BROWSER_HISTORY + 1}st visit evicts exactly the oldest rows (table capped at ${MAX_BROWSER_HISTORY})`,
    total === MAX_BROWSER_HISTORY && oldestFlood.length === 0 && newestFlood.length === 1 && preOldGone,
    `total=${total}, flood kept=${kept.length}, oldest gone=${oldestFlood.length === 0}, newest present=${newestFlood.length === 1}, pre-flood old rows evicted=${preOldGone}`,
  )

  // Clear: the dropdown footer's confirmation path ends here.
  const auditBeforeClear = auditStore.list(50).filter((e) => e.action === 'browser.historyClear').length
  browserHistoryStore.clear()
  check('clear() empties the table', browserHistoryStore.query('example', 10).length === 0 && browserHistoryStore.query('flood', 10).length === 0, '')
  const clearedAudits = auditStore.list(50).filter((e) => e.action === 'browser.historyClear')
  check('…and the clear is audited', clearedAudits.length === auditBeforeClear + 1, `${auditBeforeClear}→${clearedAudits.length}`)
}

// ── runner ─────────────────────────────────────────────────────────────────
async function launcher() {
  // `process.argv[1]` rather than `import.meta.url`: the phases are spawned from
  // a CJS bundle, where import.meta is empty (and esbuild warns about it).
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-pane-actions-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'playwright-core'],
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
            contents: `module.exports = {
              app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)}, getPath: () => ${JSON.stringify(work)}, commandLine: { appendSwitch() {} } },
              shell: { openExternal: async () => {} },
              BrowserWindow: class {},
              WebContentsView: class {},
            }`,
            loader: 'js',
          }))
        },
      },
    ],
    logLevel: 'warning',
  })
  console.log(`harness: ${bundle}\n`)

  const report = join(work, 'run.json')
  const home = mkdtempSync(join(tmpdir(), 'pm-home-pane-'))
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'run',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  if (res.error) throw res.error

  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let failed = payload.checks.filter((c) => !c.pass).length
  let total = payload.checks.length
  if (res.status !== 0) {
    failed++
    console.log(`  ✗ the run exited with ${res.status}`)
  }
  rmSync(work, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  try {
    await phaseRun()
  } catch (err) {
    console.error('  ✗ phase threw:', err instanceof Error ? err.stack : err)
  }
  if (process.env.PM_REPORT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }, null, 2))
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

// No top-level await: the bundle is CJS, where esbuild rejects it.
if (PHASE) {
  phaseMain()
} else {
  launcher().catch((err) => {
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
