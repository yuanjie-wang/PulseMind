#!/usr/bin/env node
// 记忆页存储真库探针（PLAN-memory-wiki M1，2026-10-25）：memory_pages 表 + FTS +
// 写协议执行器 + 检索栈在真实 better-sqlite3 上的往返。纯逻辑（取代链/冲突判定/
// 目录分桶/词分解）由 tests/memory-pages-store.test.ts 钉，这里钉 DB 侧：
// 建表与升级、ops 协议矩阵（含守卫与隔离）、trigram 中文检索、LIKE 兜底、
// 取代链折叠、touch、删除与 FTS 同步。
//
// 运行 recipe 同 probe-cached-tokens-db.mjs：本文件既是 launcher 也是 esbuild 入口
// （bundle 自身 + electron stub），phase 在 ELECTRON_RUN_AS_NODE 下跑真主进程模块，
// 临时 HOME 沙箱（guardHome 拒绝碰真实 ~/.pulsemind）。
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing to touch it`)
}

/** better-sqlite3 is `external` to the bundle and lives in the repo — require
 *  it through a repo-anchored resolver, like probe-project-color-db. */
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

async function openDb() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  return { DATA_DIR, getDb }
}

// ── phase fresh · 建表 + 协议矩阵 + 检索栈 ────────────────────────────────
async function phaseFresh() {
  const { getDb } = await openDb()
  const db = getDb()
  const store = await import('../src/main/storage/memory-pages-store')

  // 1-2 建表
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_pages'").get()
  check('memory_pages 表存在', !!tableSql)
  const cols = db.prepare('PRAGMA table_info(memory_pages)').all().map((c) => c.name)
  check(
    '列齐全（title/type/body/aliases/links/superseded_by/files_json/use_count/content_hash）',
    ['title', 'type', 'body', 'aliases', 'links', 'superseded_by', 'files_json', 'use_count', 'content_hash'].every((c) => cols.includes(c)),
    cols.join(',')
  )
  const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_pages_fts'").get()
  check('memory_pages_fts 存在且 tokenize=trigram', !!ftsSql && /trigram/.test(ftsSql.sql))

  // 3 create
  let rs = store.applyPageOps([
    { action: 'create', title: '楼花合同全译与术语表', type: 'decision', content: '楼花合同PDF全文全译并先建术语表，交付原生修订docx。', aliases: ['术语表', '重译'], links: [] },
  ])
  check('create 落库', rs[0].ok && store.countMemoryPages() === 1, JSON.stringify(rs))
  const pageId = rs[0].pageId

  // 4-5 撞名
  rs = store.applyPageOps([{ action: 'create', title: '楼花合同全译与术语表', type: 'fact', content: 'x' }])
  check('create 撞既有 title 被拒', !rs[0].ok && /撞名/.test(rs[0].error ?? ''), rs[0].error)
  rs = store.applyPageOps([{ action: 'create', title: '全新页', type: 'fact', content: 'x', aliases: ['术语表'] }])
  check('create 撞既有 alias 被拒', !rs[0].ok && /撞名/.test(rs[0].error ?? ''), rs[0].error)

  // 6-9 update 族
  rs = store.applyPageOps([{ action: 'update', target: '楼花合同全译与术语表', content: '楼花合同PDF全文全译并先建术语表（v2 修订），交付原生修订docx加修订清单。' }])
  check('update by title 更新正文', rs[0].ok && store.getMemoryPageById(pageId).body.includes('v2'), JSON.stringify(rs[0]))
  rs = store.applyPageOps([{ action: 'update', target: '重译', content: '楼花合同PDF全文全译并先建术语表（v3 别名寻址），交付原生修订docx加修订清单。' }])
  check('update by alias 命中同页', rs[0].ok && rs[0].pageId === pageId && store.getMemoryPageById(pageId).body.includes('v3'))
  rs = store.applyPageOps([{ action: 'update', target: '楼花合同全译与术语表', content: store.getMemoryPageById(pageId).body }])
  check('update 同文幂等 ok', rs[0].ok && rs[0].pageId === pageId)
  const longBody = '很长的历史决策正文。'.repeat(300) // 2700 字
  store.applyPageOps([{ action: 'create', title: '长文页', type: 'decision', content: longBody }])
  rs = store.applyPageOps([{ action: 'update', target: '长文页', content: '截断稿' }])
  check('update 截断防丢守卫（>1500字 且 <90%）', !rs[0].ok && /截断防丢/.test(rs[0].error ?? ''), rs[0].error)

  // 10 alias op
  store.applyPageOps([{ action: 'create', title: '称呼与协作习惯', type: 'preference', content: '称呼用户老大，每变更一 commit。', aliases: ['老大'] }])
  rs = store.applyPageOps([{ action: 'alias', target: '楼花合同全译与术语表', aliases: ['海外购房合同', '术语表'] }])
  check('alias 合并去重', rs[0].ok && store.getMemoryPageById(pageId).aliases.includes('海外购房合同') && store.getMemoryPageById(pageId).aliases.filter((a) => a === '术语表').length === 1)
  rs = store.applyPageOps([{ action: 'alias', target: '楼花合同全译与术语表', aliases: ['老大'] }])
  check('alias 撞他页被拒', !rs[0].ok && /撞名/.test(rs[0].error ?? ''), rs[0].error)

  // 11 supersede
  const oldBody = store.getMemoryPageById(pageId).body
  rs = store.applyPageOps([
    { action: 'supersede', target: '楼花合同全译与术语表', title: '楼花合同重译拍板', type: 'decision', content: '从零重译、术语表重建，不复用旧译本（取代 2026-09 版全译决定）。', aliases: ['从零重译'] },
  ])
  check('supersede 建新页 + 旧页挂链', rs[0].ok && store.getMemoryPageById(pageId).supersededBy === rs[0].pageId, `${pageId} → ${rs[0].pageId}`)
  check('活页索引只剩新页（旧页不在 index）', store.listPageIndex().some((p) => p.id === rs[0].pageId) && !store.listPageIndex().some((p) => p.id === pageId))
  const supersededHit = store.searchMemoryPages({ query: '全译并先建术语表' }).find((h) => h.record.id === rs[0].pageId)
  check('搜旧页正文折叠到活页', !!supersededHit, JSON.stringify(supersededHit?.record?.title ?? null))

  // 12-17 检索栈
  const t1 = store.searchMemoryPages({ query: '楼花合同重译' })
  check('中文 title trigram 命中且 viaFts', t1.length > 0 && t1.some((h) => h.record.title === '楼花合同重译拍板' && h.viaFts))
  const t2 = store.searchMemoryPages({ query: '字体' })
  store.applyPageOps([{ action: 'create', title: 'macOS字体', type: 'fact', content: '中文字体用 STHeiti/SimHei，等宽 Menlo。' }])
  const t2b = store.searchMemoryPages({ query: '字体' })
  check('2 字词走 LIKE 兜底命中（viaFts=false）', t2b.some((h) => h.record.title === 'macOS字体' && !h.viaFts), JSON.stringify(t2b.map((h) => h.record.title)))
  const t3 = store.searchMemoryPages({ query: '从零重译' })
  check('alias 命中', t3.some((h) => h.record.title === '楼花合同重译拍板'))
  const t4 = store.searchMemoryPages({ query: '称呼', type: 'experience' })
  check('type 过滤收窄到空', t4.length === 0, JSON.stringify(t4.map((h) => h.record.title)))
  const t5 = store.searchMemoryPages({ query: '称呼', type: 'preference' })
  check('type 过滤命中偏好页', t5.some((h) => h.record.title === '称呼与协作习惯'))
  check('空查询返回 []', store.searchMemoryPages({ query: '  ' }).length === 0)
  check('touch 记使用（use_count ≥ 1）', store.getMemoryPageById(t5[0].record.id).useCount >= 1)

  // 18-19 删除
  const macId = store.listMemoryPages().find((p) => p.title === 'macOS字体').id
  store.deleteMemoryPage(macId)
  check('删除后 FTS 同步清理（同查询不再命中）', !store.searchMemoryPages({ query: 'STHeiti' }).some((h) => h.record.id === macId))
  const liveId = store.listMemoryPages().find((p) => p.title === '楼花合同重译拍板').id
  store.deleteMemoryPage(liveId)
  check('删继任页 → 前任回到活页（链剪断）', store.getMemoryPageById(pageId).supersededBy === null && store.listPageIndex().some((p) => p.id === pageId))

  // 20 op 级隔离
  rs = store.applyPageOps([
    { action: 'create', title: '隔离批一', type: 'fact', content: 'ok1' },
    { action: 'create', type: 'fact' }, // 缺 title → 抛错
    { action: 'create', title: '隔离批二', type: 'fact', content: 'ok2' },
  ])
  check('op 级隔离：坏 op 不拖垮同批', rs[0].ok && !rs[1].ok && rs[2].ok, JSON.stringify(rs.map((r) => r.ok)))

  // 21 目录
  const cat = store.pageCatalog()
  check('目录 full 模式含 title/type/别名', cat.mode === 'full' && cat.text.includes('(fact)') && cat.text.includes('别名:'), cat.text.slice(0, 80))
}

// ── phase upgrade · 旧库（无 memory_pages）原地升级 ──────────────────────
async function phaseUpgrade() {
  const { getDb } = await openDb()
  const db = getDb()
  db.exec('DROP TABLE IF EXISTS memory_pages')
  db.exec('DROP TABLE IF EXISTS memory_pages_fts')
  check('模拟旧库：两表已删', !db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('memory_pages','memory_pages_fts')").get())

  const { initializeDatabase } = await import('../src/main/storage/database')
  await initializeDatabase()
  const store = await import('../src/main/storage/memory-pages-store')
  check('升级后两表重建', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_pages'").get() && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_pages_fts'").get())
  const rs = store.applyPageOps([{ action: 'create', title: '升级后新页', type: 'fact', content: '升级路径可用' }])
  check('升级路径 ops 可用', rs[0].ok && store.searchMemoryPages({ query: '升级路径' }).length > 0)
}

// ── runner（recipe 同 probe-cached-tokens-db）──────────────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('could not resolve the Electron binary — run npm install')

  const work = mkdtempSync(join(tmpdir(), 'pm-memory-pages-db-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'jsdom', 'playwright-core', 'chromium-bidi'],
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
            contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`,
            loader: 'js',
          }))
        },
      },
    ],
    logLevel: 'warning',
  })

  const home = mkdtempSync(join(tmpdir(), 'pm-home-memory-pages-'))
  const run = (phase) => {
    const report = join(work, `${phase}.json`)
    const res = spawnSync(electronBin, [bundle], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PM_REPO: REPO_ROOT,
        PM_PHASE: phase,
        PM_HOME: home,
        PM_REPORT: report,
        HOME: home,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    })
    if (res.error) throw res.error
    let payload = { checks: [] }
    if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
    return { status: res.status, ...payload }
  }

  let failed = 0
  let total = 0
  console.log(`① fresh install — 建表 + 协议矩阵 + 检索栈        HOME=${home}`)
  const one = run('fresh')
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) { failed++; console.log(`  ✗ phase fresh exited with ${one.status}`) }

  console.log('\n② existing install upgrades in place（模拟旧库缺表）')
  const two = run('upgrade', home)
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) { failed++; console.log(`  ✗ phase upgrade exited with ${two.status}`) }

  if (KEEP) console.log(`\nkept: ${work} ${home}`)
  else { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  if (PHASE === 'fresh') return phaseFresh()
  if (PHASE === 'upgrade') return phaseUpgrade()
  throw new Error(`unknown PM_PHASE ${PHASE}`)
}

if (PHASE) {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(err?.stack || err)
    process.exit(1)
  })
}
