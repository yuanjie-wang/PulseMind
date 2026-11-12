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

  // ── 22 正文撞重门（2026-11-12 记忆防重）────────────────────────────────
  const dupBody = 'OCR 选型：RapidOCR 走本地，中文识别稳，迁 onnxruntime-web WASM 作为后续方向。'
  rs = store.applyPageOps([{ action: 'create', title: '撞重源页', type: 'decision', content: dupBody }])
  check('撞重源页落库', rs[0].ok, rs[0].error)
  const srcId = rs[0].pageId
  rs = store.applyPageOps([{ action: 'create', title: '撞重副本页', type: 'decision', content: dupBody }])
  check('create 同正文被拒（正文撞重）', !rs[0].ok && /正文撞重/.test(rs[0].error ?? ''), rs[0].error)
  check('被拒后没多出副本页', !store.listPageIndex().some((p) => p.title === '撞重副本页'))

  store.applyPageOps([{ action: 'create', title: '短正文一', type: 'fact', content: '待补充' }])
  rs = store.applyPageOps([{ action: 'create', title: '短正文二', type: 'fact', content: '待补充' }])
  check('极短正文不设门（<24 字，样板话重合是噪声）', rs[0].ok, rs[0].error)

  rs = store.applyPageOps([{ action: 'supersede', target: '短正文一', title: '短正文一的继任', type: 'fact', content: dupBody }])
  check('supersede 同正文被拒（换个 id 复制一份不算取代）', !rs[0].ok && /正文撞重/.test(rs[0].error ?? ''), rs[0].error)

  // ── 23 合并组：同批 supersede 到同一新标题只建一页 ──────────────────────
  const bodyA = '交付分工甲：pptx 走演示，docx 走正文，pdf 走传阅，三者不混。'
  const bodyB = '交付分工乙：pptx 讲、docx 读、pdf 传阅，按渠道分开交付。'
  const seeds = store.applyPageOps([
    { action: 'create', title: '待并页甲', type: 'fact', content: bodyA },
    { action: 'create', title: '待并页乙', type: 'fact', content: bodyB },
  ])
  const [idA, idB] = seeds.map((r) => r.pageId)
  const mergeBody = '交付分工：pptx 讲、docx 读、pdf 传阅——按渠道分开，三者不混用。'
  rs = store.applyPageOps([
    { action: 'supersede', target: idA, title: '交付分工统一页', type: 'fact', content: mergeBody },
    { action: 'supersede', target: idB, title: '交付分工统一页', type: 'fact', content: mergeBody },
  ])
  check('合并组两个 op 都成功（第二个不再撞第一个建出的新页）', rs.every((r) => r.ok), JSON.stringify(rs.map((r) => r.error ?? true)))
  const mergedId = rs[0].pageId
  check('合并组只建一页（不是 N 个同标题新页）', store.listMemoryPages().filter((p) => p.title === '交付分工统一页').length === 1, `count=${store.listMemoryPages().filter((p) => p.title === '交付分工统一页').length}`)
  check(
    '两旧页都挂到同一个新 id',
    store.getMemoryPageById(idA).supersededBy === mergedId && store.getMemoryPageById(idB).supersededBy === mergedId,
    `${idA}/${idB} → ${mergedId}`,
  )
  check('合并后活页池只剩合并页', store.listPageIndex().some((p) => p.id === mergedId) && !store.listPageIndex().some((p) => p.id === idA || p.id === idB))

  // ── 23b 自环守卫：规范标题取成员既有标题时，第 2 个 op 的裸标题会解析到本批新建的新页 ──
  // 这是合并最常见的形态（两页并成一份，标题沿用其中一个），也是旧实现唯一的静默失效面：
  // 新页 updated_at = now 排索引第一 → target 命中新页 → superseded_by = 自身。
  const loopSeeds = store.applyPageOps([
    { action: 'create', title: '自环守甲', type: 'fact', content: '自环守甲：合并组自环用例的第一个成员（正文甲）。' },
    {
      action: 'create',
      title: '自环守乙',
      type: 'fact',
      content: '自环守乙：合并组自环用例的第二个成员（正文乙）。',
      files: [{ path: 'scripts/loop-b.js', content: 'export const b = 1' }],
    },
  ])
  const [loopA, loopB] = loopSeeds.map((r) => r.pageId)
  check(
    '自环用例两页建好（乙带脚本，用来验 join 的 files 并集）',
    loopSeeds.every((r) => r.ok) && store.getMemoryPageById(loopB).files?.length === 1,
    JSON.stringify(loopSeeds.map((r) => r.error ?? true)),
  )
  // 关键：让 op1 建出的新页在 updated_at 上严格晚于被取代页。同毫秒并列时 SQLite 按
  // rowid 返回（旧页在前），target 会直接解析到旧页、走不到「命中本组新页」那条路径。
  await new Promise((resolve) => setTimeout(resolve, 5))
  const loopBody = '自环守：两页并成一页，规范标题沿用「自环守乙」。'
  const loopRs = store.applyPageOps([
    { action: 'supersede', target: loopA, title: '自环守乙', type: 'fact', content: loopBody, aliases: ['自环守别名'] },
    // target 是裸标题：在本批新建的索引里会命中刚建的新页自身
    { action: 'supersede', target: '自环守乙', title: '自环守乙', type: 'fact', content: loopBody, aliases: ['自环守乙的检索词'], links: ['自环守关联页'] },
  ])
  const loopNewId = loopRs[0].pageId
  check('自环用例两 op 都成功（裸标题命中新页也要接住，不能静默失效）', loopRs.every((r) => r.ok), JSON.stringify(loopRs.map((r) => r.error ?? true)))
  const loopPage = store.getMemoryPageById(loopNewId)
  check('新页没有 superseded_by = 自身（按批前快照重解析回旧页）', loopPage.supersededBy === null && store.listPageIndex().some((p) => p.id === loopNewId), `supersededBy=${loopPage.supersededBy}`)
  check(
    '两个旧页都挂到新页（合并真的完成了，不是只建页不取代）',
    store.getMemoryPageById(loopA).supersededBy === loopNewId && store.getMemoryPageById(loopB).supersededBy === loopNewId,
    `${loopA}/${loopB} → ${loopNewId}`,
  )
  check(
    'join 并入第 2 个 op 的 aliases/links（否则检索面静默缩水）',
    loopPage.aliases.includes('自环守乙的检索词') && loopPage.links.includes('自环守关联页'),
    JSON.stringify({ aliases: loopPage.aliases, links: loopPage.links }),
  )
  check(
    'join 并入被取代页的脚本（否则继任页丢脚本、maturity 掉回 narrative）',
    (loopPage.files ?? []).some((f) => f.path === 'scripts/loop-b.js') && loopPage.maturity === 'sop',
    JSON.stringify({ files: (loopPage.files ?? []).length, maturity: loopPage.maturity }),
  )
  check('检索命中自环用例的新页（目录与检索不再不一致）', store.searchMemoryPages({ query: '自环守乙' }).some((h) => h.record.id === loopNewId))

  // ── 24 #id 直接寻址（同名页无法按 title 区分时的精确指认）──────────────
  rs = store.applyPageOps([{ action: 'update', target: `#${srcId}`, content: `${dupBody}（按 #id 精确指认后修订）` }])
  check('#id 直接寻址命中该页', rs[0].ok && rs[0].pageId === srcId, rs[0].error)

  // ── 25 upsert 路径的撞重门：跳过而非抛错（启动期迁移不能崩）────────────
  const before = store.countMemoryPages()
  const upserted = store.upsertMemoryPage({ title: 'upsert 撞重页', type: 'fact', body: mergeBody })
  check('upsert 同正文：跳过写入并返回既有页', store.countMemoryPages() === before && upserted.title === '交付分工统一页', `${upserted.title} / +${store.countMemoryPages() - before}`)
  const forced = store.upsertMemoryPage({ title: 'upsert 显式放行页', type: 'fact', body: mergeBody, allowDuplicateBody: true })
  check('allowDuplicateBody 显式放行（迁移重放/审计导入）', store.countMemoryPages() === before + 1 && forced.title === 'upsert 显式放行页', forced.title)

  // ── 26 清空提取记忆：按类型整族删（user 2026-11-12「记忆设置面板中，需要提供清空按钮」）──
  // 三型各建一页 + 一张经验页（经验走 ops → 磁盘真源；upsert 会写 DB 残留行）。
  // retire 已改硬删除（2026-11-12 裁定），「历史行」改用 superseded 造——行保留挂链，
  // 用来验证清空**不只清活页**：面板把灰卡也画出来，只清活页会留一屏灰卡。
  const clrPref = store.upsertMemoryPage({ title: '清空用例偏好', type: 'preference', body: '清空用例正文-偏好' })
  const clrDec = store.upsertMemoryPage({ title: '清空用例决策', type: 'decision', body: '清空用例正文-决策' })
  store.upsertMemoryPage({ title: '清空用例事实', type: 'fact', body: '清空用例正文-事实' })
  const clrExp = store.applyPageOps([{ action: 'create', title: '清空用例经验', type: 'experience', content: '清空用例正文-经验' }])
  check('清空用例经验建成（磁盘真源）', clrExp[0].ok && store.getMemoryPageById(clrExp[0].pageId)?.body === '清空用例正文-经验', clrExp[0].error)
  const supRs = store.applyPageOps([{ action: 'supersede', target: '清空用例决策', title: '清空用例决策·继任', type: 'decision', content: '清空用例正文-决策（继任版正文）' }])
  check('清空用例历史行建成（supersede 保留旧 decision 行）', supRs[0].ok && store.getMemoryPageById(clrDec.id)?.supersededBy === supRs[0].pageId, supRs[0].error)
  const allBefore = store.listMemoryPages().length
  const expBefore = store.listMemoryPages('experience').length
  const historyBefore = store.listMemoryPages('decision').filter((p) => p.supersededBy).length
  check('清空用例种子就位（含 1 条被取代决策）', expBefore >= 1 && historyBefore >= 1, `all=${allBefore} exp=${expBefore} history=${historyBefore}`)

  const removed = store.clearMemoryPagesByTypes(['preference', 'decision', 'fact'])
  check(
    '清空三型：删除行数 == 除经验外的全部行（被取代的历史行一并清）',
    removed === allBefore - expBefore,
    `removed=${removed} expected=${allBefore - expBefore}`,
  )
  check('经验页一条未动（归技能中心，不随「清空记忆」消失）', store.listMemoryPages('experience').length === expBefore)
  check(
    '三型活页清零',
    ['preference', 'decision', 'fact'].every((tp) => store.countMemoryPages(tp) === 0),
    ['preference', 'decision', 'fact'].map((tp) => `${tp}=${store.countMemoryPages(tp)}`).join(','),
  )
  const ftsRows = db.prepare('SELECT count(*) AS n FROM memory_pages_fts').get().n
  const mainRows = db.prepare('SELECT count(*) AS n FROM memory_pages').get().n
  check('FTS 与主表行数一致（清空不留检索幽灵）', ftsRows === mainRows, `fts=${ftsRows} main=${mainRows}`)
  const dangling = db
    .prepare('SELECT count(*) AS n FROM memory_pages WHERE superseded_by IS NOT NULL AND superseded_by NOT IN (SELECT id FROM memory_pages)')
    .get().n
  check('无死链：指向已删页的 superseded_by 已剪断', dangling === 0, `dangling=${dangling}`)
  // FTS 是 trigram 分词：查「…正文-偏好」会拆出「清空用/空用例/用例正/例正文/正文-」，
  // 与经验页「…正文-经验」共享前 5 个 trigram，故按 length===0 判定会假红。按 id 判定。
  check(
    '已删除的那一页检索不到（按 id 判定，trigram 会命中共享前缀）',
    store.searchMemoryPages({ query: '清空用例正文-偏好' }).every((h) => h.record.id !== clrPref.id),
  )

  // ── 27 停用不被复活（review 2026-11-12 实锤后修复：ensure 的 ON CONFLICT 不再碰 enabled）──
  const rev = store.applyPageOps([{ action: 'create', title: '复活用例经验', type: 'experience', content: '复活用例正文一', aliases: ['复活用例别名'] }])
  check('复活用例建成', rev[0].ok, rev[0].error)
  store.setMemoryPageEnabled(rev[0].pageId, false)
  const afterDisable = store.getMemoryPageById(rev[0].pageId)?.enabled
  const touchRs = store.applyPageOps([
    { action: 'update', target: '复活用例经验', content: '复活用例正文二（修订）' },
    { action: 'alias', target: '复活用例经验', aliases: ['复活用例别名二'] },
    { action: 'reinforce', target: '复活用例经验', note: '又重现了一次' },
  ])
  check(
    '停用的经验经 update/alias/reinforce 后仍是停用（ensure 不覆写 enabled）',
    touchRs.every((r) => r.ok) && afterDisable === false && store.getMemoryPageById(rev[0].pageId)?.enabled === false,
    `afterDisable=${afterDisable} final=${store.getMemoryPageById(rev[0].pageId)?.enabled}`,
  )
  store.deleteMemoryPage(rev[0].pageId)

  // ── 28 混合合并组：经验成员并入非经验新页也要挂取代链（review 2026-11-12 实锤后修复）──
  const mixA = store.applyPageOps([{ action: 'create', title: '混合组决策甲', type: 'decision', content: '混合组决策甲正文' }])
  const mixB = store.applyPageOps([{ action: 'create', title: '混合组经验乙', type: 'experience', content: '混合组经验乙正文' }])
  check('混合组种子两页建好', mixA[0].ok && mixB[0].ok, JSON.stringify([mixA[0].error, mixB[0].error]))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const mixRs = store.applyPageOps([
    { action: 'supersede', target: '混合组决策甲', title: '混合组合并页', type: 'fact', content: '混合组合并正文（甲+乙）', aliases: ['混合组合并别名'] },
    { action: 'supersede', target: '混合组经验乙', title: '混合组合并页', type: 'fact', content: '混合组合并正文（甲+乙）', aliases: ['混合组合并别名'] },
  ])
  const mixExpId = mixB[0].pageId
  const mixExpAfter = store.getMemoryPageById(mixExpId)
  check(
    'join 臂给经验成员挂上取代链（superseded_by 落 experience_uses，不再 UPDATE 落 0 行）',
    mixRs.every((r) => r.ok) && mixExpAfter?.supersededBy === mixRs[0].pageId,
    JSON.stringify({ errors: mixRs.map((r) => r.error ?? null), supersededBy: mixExpAfter?.supersededBy, newId: mixRs[0].pageId }),
  )
  check('被合并的经验不再是活经验（listPageIndex 排除被取代者；listMemoryPages 含历史行属面板需要）', !store.listPageIndex().some((p) => p.id === mixExpId) && !store.listMemoryPages('experience').some((p) => p.id === mixExpId && !p.supersededBy))
  store.deleteMemoryPage(mixRs[0].pageId)

  // ── 29 DB 残留经验行让位磁盘（review 2026-11-12 实锤后修复）──
  // 标记文本选不与磁盘经验共享二字组的独有串（LIKE 兜底走 CJK 滑窗二元组，共用
  // 「用例」「正文」这类高频组会假命中磁盘页）；判定一律按 id。
  db.prepare(`INSERT INTO memory_pages (id, title, type, summary, body, aliases, links, superseded_by, source_conversation_id, files_json, maturity, use_count, last_used_at, content_hash, created_at, updated_at)
    VALUES ('page_stale_exp_probe', '残留行独有标记壹贰叁', 'experience', '旧DB摘要', '残留行独有正文肆伍陆柒捌玖拾', '[]', '[]', NULL, NULL, NULL, 'clue', 0, NULL, 'x', '2026-01-01', '2026-01-01')`).run()
  const staleSearch = store.searchMemoryPages({ query: '残留行独有', type: 'experience' })
  check('残留 experience 行不进检索（磁盘胜）', staleSearch.every((h) => h.record.id !== 'page_stale_exp_probe'), JSON.stringify(staleSearch.map((h) => h.record.id)))
  check('残留行也不进 id 直查（getMemoryPageById 让位磁盘）', store.getMemoryPageById('page_stale_exp_probe') === null)
  const staleFree = store.listMemoryPages('experience')
  check('type=experience 检索走磁盘活页（残留行清场后只回磁盘命中）', staleFree.some((p) => p.title === '清空用例经验') && store.searchMemoryPages({ query: '清空用例正文-经验', type: 'experience' }).some((h) => h.record.id === clrExp[0].pageId))
  // 磁盘命中走检索后记账进 experience_uses（LRU 判据面），memory_pages 的 UPDATE 落 0 行
  const usesBefore = db.prepare('SELECT use_count AS n FROM experience_uses WHERE id = ?').get(clrExp[0].pageId)?.n ?? 0
  store.searchMemoryPages({ query: '清空用例正文-经验', type: 'experience' })
  const usesAfter = db.prepare('SELECT use_count AS n FROM experience_uses WHERE id = ?').get(clrExp[0].pageId)?.n ?? 0
  check('磁盘经验的检索记账进 experience_uses', usesAfter === usesBefore + 1, `${usesBefore} → ${usesAfter}`)
  db.prepare("DELETE FROM memory_pages WHERE id = 'page_stale_exp_probe'").run()
  store.deleteMemoryPage(clrExp[0].pageId)
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
