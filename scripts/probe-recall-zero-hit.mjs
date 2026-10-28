#!/usr/bin/env node
/**
 * recall 零命中修复探针（2026-10-28）— real SQLite, real main-process store
 * modules, no Electron window. vitest cannot open the database (better-sqlite3
 * is Electron-ABI; `npm test` runs plain Node), so the DB-layer behaviour of
 * the ① conversation 切词 OR + matchScore 粗排 and ② memory LIKE 兜底 head 加权
 * is proven here — esbuild-bundle the main modules, run the bundle under the
 * Electron binary in ELECTRON_RUN_AS_NODE mode, sandboxed into a fresh temp
 * HOME (same recipe as scripts/probe-memory-pages-sop.mjs).
 *
 * What only a real database can prove:
 *   - ① the report's exact failing query ("Muse 体验 评测 功能") — zero under the
 *     old whole-string LIKE — now hits, and the multi-needle row ranks first;
 *   - ① the word-order flip is pinned both ways: permuting the same words swaps
 *     the champion row (matchScore 粗排), OR recall keeps the rest in the list;
 *   - ① empty-needle queries short-circuit; dateFilter still composes;
 *   - ② a title/aliases LIKE hit ranks above a body-only hit (both viaFts=false),
 *     and an FTS bm25 hit still outranks every LIKE hit;
 *   - use_count touch still runs over the ranked hits.
 *
 * Usage: node scripts/probe-recall-zero-hit.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const conv = await import('../src/main/storage/conversation.db')
  const store = await import('../src/main/storage/memory-pages-store')
  const db = getDb()

  const t0 = '2026-10-28T10:00:00.000Z'
  const insConv = db.prepare(
    `INSERT INTO conversations (id, title, type, summary, keywords, created_at, updated_at)
     VALUES (?, ?, 'normal', ?, ?, ?, ?)`
  )
  // conv-phrase：q2 的三个词是其 summary 的连续片段（旧整串 LIKE 的唯一幸存场景）
  insConv.run('conv-phrase', 'Muse 竞品拆解', 'Muse 拆解 产品的方法论与竞品对照', 'muse,拆解,产品', t0, t0)
  // conv-scatter：q1 的四个词全部出现但无连续短语——旧实现下正是零命中受害者
  insConv.run('conv-scatter', 'Muse 体验讨论', '围绕体验的功能盘点与评测要点，Muse 只是顺带出现', 'muse', t0, t0)
  insConv.run('conv-noise', '天气播报格式', '出行建议与 200 字上限', '', t0, t0)
  // conv-kw：q1 的命中只落在 keywords 字段（三字段覆盖）
  insConv.run('conv-kw', '代码审查规范', null, 'muse,评测', t0, t0)

  // ── ① conversation 源 ──
  console.log('\n① searchConversationsByKeyword：切词 OR + matchScore 粗排')
  const q1 = conv.searchConversationsByKeyword('Muse 体验 评测 功能')
  check('报告原查询非空（旧整串 LIKE 下为零命中）', q1.length > 0, q1.map((h) => h.id).join(','))
  const q1Order = q1.map((h) => h.id).join(',')
  const q1Scores = db.prepare(
    `SELECT id, COALESCE(title LIKE '%muse%' OR summary LIKE '%muse%' OR keywords LIKE '%muse%', 0) +
       COALESCE(title LIKE '%体验%' OR summary LIKE '%体验%' OR keywords LIKE '%体验%', 0) +
       COALESCE(title LIKE '%评测%' OR summary LIKE '%评测%' OR keywords LIKE '%评测%', 0) +
       COALESCE(title LIKE '%功能%' OR summary LIKE '%功能%' OR keywords LIKE '%功能%', 0) AS s
     FROM conversations ORDER BY id`
  ).all()
  check('多词齐中的行排前（scatter=4 词 > kw=2 词 > phrase=1 词）',
    q1Order === 'conv-scatter,conv-kw,conv-phrase',
    `${q1Order} | raw scores: ${q1Scores.map((r) => `${r.id}=${r.s}`).join(' ')} | prod-replica: ${(() => {
      const ns = ['muse', '体验', '评测', '功能']
      const ps = ns.map((n) => `%${n}%`)
      const lt = `COALESCE(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\', 0)`
      const ts = ns.map(() => lt)
      const clausePats = ps.flatMap((p) => [p, p, p])
      const sql = `SELECT id, matchScore FROM (
         SELECT id, updated_at AS updatedAt, ${ts.join(' + ')} AS matchScore
         FROM conversations
         WHERE type = 'normal' AND (${ts.join(' OR ')})
       ) ORDER BY matchScore DESC, updatedAt DESC`
      return db.prepare(sql).all(...[...clausePats, ...clausePats]).map((r) => `${r.id}=${r.matchScore}`).join(' ')
    })()}`)
  check('OR 保召回：noise 不在列', !q1Order.includes('conv-noise'), q1Order)

  const q2 = conv.searchConversationsByKeyword('Muse 拆解 产品')
  check('换词序后冠军换人（phrase=3 词 > 其余 1 词）——翻转双向钉死',
    q2[0]?.id === 'conv-phrase', q2.map((h) => h.id).join(','))
  check('换词序不丢其余行（OR 不要求短语连续）', q2.length >= 2, String(q2.length))

  check('无关查询零命中', conv.searchConversationsByKeyword('blockchain 区块链').length === 0)
  check('纯单字符查询空 needle 短路（与 builder 口径一致）',
    conv.searchConversationsByKeyword('a b').length === 0)

  const qDf = conv.searchConversationsByKeyword('Muse 拆解 产品', 20, { createdAfter: '2026-10-29T00:00:00.000Z' })
  check('dateFilter 仍生效（未来 createdAfter → 空）', qDf.length === 0)
  const qDf2 = conv.searchConversationsByKeyword('Muse 拆解 产品', 20, { createdAfter: '2026-10-27T00:00:00.000Z' })
  check('dateFilter 宽窗口不误伤', qDf2.length >= 2, String(qDf2.length))

  // ── ② memory 源：LIKE 兜底 head 加权 ──
  console.log('\n② searchMemoryPages：兜底内部 head 命中加权')
  const insPage = db.prepare(
    `INSERT INTO memory_pages (id, title, type, body, aliases, content_hash, created_at, updated_at)
     VALUES (?, ?, 'fact', ?, ?, ?, ?, ?)`
  )
  insPage.run('page-head', '竞品评测纪要', '正文与查询词无关', '[]', 'h1', t0, t0)
  insPage.run('page-body', '会议记录', '关于功能的补充讨论', '[]', 'h2', t0, t0)
  insPage.run('page-alias', '无关的页', '正文无查询词', '["评测","功能"]', 'h3', t0, t0)
  insPage.run('page-fts', '无关主题', 'Muse analysis deep dive notes', '[]', 'h4', t0, t0)
  db.exec(`INSERT INTO memory_pages_fts (title, aliases_text, body, page_id) VALUES
    ('竞品评测纪要', '', '正文与查询词无关', 'page-head'),
    ('会议记录', '', '关于功能的补充讨论', 'page-body'),
    ('无关的页', '评测 功能', '正文无查询词', 'page-alias'),
    ('无关主题', '', 'Muse analysis deep dive notes', 'page-fts')`)

  const m1 = store.searchMemoryPages({ query: '评测 功能' })
  const m1Ids = m1.map((h) => h.record.id)
  check('纯 LIKE 查询（二字词，ftsExpr 空）三页皆中', m1.length === 3, m1Ids.join(','))
  check('head 命中（title/aliases）排 body-only 之前',
    m1Ids.indexOf('page-body') === m1Ids.length - 1, m1Ids.join(','))
  check('兜底命中一律 viaFts=false', m1.every((h) => !h.viaFts))

  const m2 = store.searchMemoryPages({ query: 'Muse 评测' })
  const m2Ids = m2.map((h) => h.record.id)
  check('FTS bm25 命中仍压过一切 LIKE 兜底（负分 < 中位 50）',
    m2Ids[0] === 'page-fts' && m2Ids[1] === 'page-head', m2Ids.join(','))
  check('viaFts 只标 FTS 命中', m2[0].viaFts === true && m2[1].viaFts === false)

  const m3 = store.searchMemoryPages({ query: 'Muse 体验 评测 功能' })
  const m3Ids = m3.map((h) => h.record.id)
  check('报告原查询 memory 源四页皆中且 FTS 最前、body-only 最后',
    m3Ids[0] === 'page-fts' && m3Ids[m3Ids.length - 1] === 'page-body' && m3Ids.length === 4,
    m3Ids.join(','))

  const headUse = db.prepare('SELECT use_count FROM memory_pages WHERE id = ?').get('page-head')
  check('排序后的命中照常 touch use_count', Number(headUse.use_count) > 0, String(headUse.use_count))
}

async function launcher() {
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = fromRepo('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-recall-zero-hit-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [process.argv[1]],
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-recall-zero-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'main',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home,
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let failed = payload.checks.filter((c) => !c.pass).length
  let total = payload.checks.length
  if (res.status !== 0) { failed++; console.log(`✗ phase main exited with ${res.status}`) }

  if (KEEP) console.log(`\nkept: ${join(work)} ${home}`)
  else { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
