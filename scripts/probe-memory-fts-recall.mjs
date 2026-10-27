#!/usr/bin/env node
// M0a 召回探针 v2（PLAN-memory-wiki，2026-10-25）：真实记忆库上三方对照——
//   A. 生产现状：LIKE %q% 整串包含（memory.db.ts searchMemories）
//   B. 朴素 trigram：FTS 短语匹配整句查询（v1 形态，已证 0% 改写命中，留作下界对照）
//   C. 计划检索栈：模拟记忆页（title + aliases + body，按提取/迁移协议的产物形态
//      手工构造）× 词拆分匹配（≥3 字符词走 trigram FTS phrase、短词与 CJK 长串的
//      滑窗二元组走 LIKE 兜底，bm25 排序 + LIKE 恒后位）。
//
// v1 教训（2026-10-25 实测）：整句改写查询与平铺记忆内容零 trigram 重叠，FTS/LIKE
// 双双 0% 命中——页面层（标题+别名）不是锦上添花，是无向量方案语义盲区的主承重。
//
// go/no-go 门：C 栈改写查询 top-5 命中 ≥70%，且 C 原词/改写全面 ≥ A。
// 已知局限（协议层兜底，非检索层）：自然语言整句查询在无词面重叠时仍可能 miss，
// 静态协议节教模型「无结果时换关键词重试」（M4 落地）。
//
// 诚实性声明：PAGES 簇的 title/aliases 按「内容自身的主题词 + 显而易见的同义说法」
// 手工撰写（迁移 LLM 将被要求产出同形态产物），撰写时未逐条反推测试查询——但作者
// 同时设计了查询对，存在乐观偏差的可能；C 栈结果应视为上界，M3 的 pages 回归探针
// 在真实提取产物上复测。
//
// 运行 recipe 同 probe-cached-tokens-db.mjs（ELECTRON_RUN_AS_NODE + 临时 HOME +
// 真库只读拷贝）。负向对照：PHASE 里把 PAGES_MATCH 换成整句短语匹配应跌回 B 的水平。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const req = createRequire(path.join(REPO_ROOT, 'package.json'))
const electronBin = req('electron')

// ── 查询对（对着 2026-10-25 真实库内容手工拟定；expect = 簇内任一 rowid 进 top-5）──
const QUERY_PAIRS = [
  { exact: '客户认知档案', para: '给高层的报告写多长', expect: [3, 50] },
  { exact: 'KYC能力智能化升级', para: '信贷项目正式名称', expect: [8, 52] },
  { exact: 'AI资讯日报', para: '每日新闻推送怎么做', expect: [9, 53] },
  { exact: 'macOS 中文字体', para: '做PPT用什么字体', expect: [13, 56] },
  { exact: 'docx转PDF', para: '交付文件格式分工', expect: [14, 57] },
  { exact: '称呼用户老大', para: '怎么称呼我', expect: [18, 60] },
  { exact: '数据口径', para: '多个来源数字不一致', expect: [30, 62] },
  { exact: '智能KYC双路径', para: '认知和决策的边界', expect: [34, 63] },
  { exact: '楼花合同', para: '海外购房翻译项目', expect: [47, 48, 49, 67, 68, 69, 72] },
  { exact: '三套 Node', para: '电脑上node版本', expect: [70] },
  { exact: '境外天气核对源', para: 'NWS met.no 可用性', expect: [71] },
  { exact: 'Open-Meteo', para: '空气质量数据接口', expect: [58] },
  { exact: '客户刻画八维度', para: '用户画像维度', expect: [64] },
  { exact: '章节号错位', para: '口语版本对不上文件', expect: [65] },
  { exact: 'AI改造大数据平台', para: '平台升级目标', expect: [66] },
  { exact: '先调提纲不写正文', para: '写材料的流程', expect: [17, 59] },
  { exact: 'codegraph', para: '查调用关系的工具', expect: [12, 55] },
  { exact: '天气交付', para: '天气播报格式要求', expect: [61] },
  { exact: '术语表', para: '翻译前先建什么', expect: [49, 67, 72] },
  { exact: '每变更一 commit', para: '提交纪律', expect: [18, 60] },
]

// ── 模拟记忆页：39 行 → 24 簇（title + 别名即「预期检索词」+ 簇内 rowIds）──
const PAGES = [
  { title: '客户认知档案分档', aliases: ['报告长度', '给谁读', '结论级'], rows: [3, 50] },
  { title: '认知层红线', aliases: ['认知边界', '杀熟', '未知收敛'], rows: [5, 51] },
  { title: 'KYC能力智能化升级', aliases: ['信贷项目', '项目正式名', 'KYC项目'], rows: [8, 52] },
  { title: 'AI资讯日报', aliases: ['新闻推送', '每日资讯', '探源'], rows: [9, 53] },
  { title: '代码审查规范', aliases: ['审查', 'review', '三级'], rows: [11, 54] },
  { title: '环境工具坑', aliases: ['codegraph', 'awk', 'HN search'], rows: [12, 55] },
  { title: 'macOS字体', aliases: ['字体', 'deck字体', 'PPT字体'], rows: [13, 56] },
  { title: '交付格式分工', aliases: ['文件格式', 'pptx', 'docx'], rows: [14, 57] },
  { title: '写稿流程与风格', aliases: ['提纲', '润色', '高层材料', '去AI味'], rows: [17, 59] },
  { title: '称呼与协作习惯', aliases: ['称呼', '老大', 'commit', 'ask_user'], rows: [18, 60] },
  { title: '境内天气第三源', aliases: ['中国天气网', 'itboy', '中央气象台'], rows: [20] },
  { title: '数据口径纪律', aliases: ['信源等级', '数字不一致', '多口径'], rows: [30, 62] },
  { title: '智能KYC双路径', aliases: ['认知决策边界', '数据层', '刻画层'], rows: [34, 63] },
  { title: '楼花合同版式档位', aliases: ['复刻', '版式', '页码'], rows: [47, 69] },
  { title: '合同译稿版式偏好', aliases: ['译稿', '贴近原件'], rows: [48, 68] },
  { title: '楼花合同全译与术语表', aliases: ['术语表', '重译', '修订'], rows: [49, 67, 72] },
  { title: 'Open-Meteo可用字段', aliases: ['空气质量', 'AQI', 'pm2.5'], rows: [58] },
  { title: '天气交付格式', aliases: ['天气播报', '200字', '出行建议'], rows: [61] },
  { title: '客户刻画八维度', aliases: ['画像维度', '八维度', '身份财务'], rows: [64] },
  { title: 'KYC报告章节错位', aliases: ['章节号', '口语版', '业务面'], rows: [65] },
  { title: 'AI改造大数据平台', aliases: ['降门槛', '平台升级', '沉淀经验'], rows: [66] },
  { title: 'Node多版本并存', aliases: ['node版本', 'nvm', '全局包'], rows: [70] },
  { title: '境外天气核对源', aliases: ['NWS', 'met.no', '天气源探测'], rows: [71] },
  { title: '楼花合同重译拍板', aliases: ['从零重译', '不复用旧译'], rows: [72] },
]

const PHASE = String.raw`
const fs = require('node:fs')
const Database = require('better-sqlite3')
const db = new Database(process.env.PM_DB_COPY)
const rows = db.prepare('SELECT rowid, content FROM memories ORDER BY rowid').all()
const contentOf = (id) => (rows.find((r) => r.rowid === id) || {}).content || ''

// A. 生产现状：整串 LIKE
const likeRaw = (q) => {
  const needle = q.toLowerCase()
  const out = []
  for (const r of rows) {
    if (r.content.toLowerCase().includes(needle)) out.push(r.rowid)
    if (out.length >= 5) break
  }
  return out
}

// B. 朴素 trigram：整句短语
db.exec("CREATE VIRTUAL TABLE raw_fts USING fts5(content, tokenize='trigram')")
{
  const ins = db.prepare('INSERT INTO raw_fts(rowid, content) VALUES (?, ?)')
  db.transaction(() => { for (const r of rows) ins.run(r.rowid, r.content) })()
}
const ftsPhraseRaw = (q) => {
  try {
    return db.prepare('SELECT rowid FROM raw_fts WHERE raw_fts MATCH ? ORDER BY rank LIMIT 5')
      .all('"' + q.replace(/"/g, '""') + '"').map((r) => r.rowid)
  } catch { return [] }
}

// C. 计划检索栈：记忆页 + 词拆分匹配
const pages = JSON.parse(fs.readFileSync(process.env.PM_PAGES, 'utf8')).map((p) => ({
  ...p,
  aliases_text: p.aliases.join(' '),
  body: p.rows.map(contentOf).join('\n'),
  hay: (p.title + '\n' + p.aliases.join('\n') + '\n' + p.rows.map(contentOf).join('\n')).toLowerCase(),
}))
db.exec("CREATE VIRTUAL TABLE page_fts USING fts5(title, aliases_text, body, page_id UNINDEXED, tokenize='trigram')")
{
  const ins = db.prepare('INSERT INTO page_fts(title, aliases_text, body, page_id) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    pages.forEach((p, i) => ins.run(p.title, p.aliases_text, p.body, i))
  })()
}
const LIKE_SCORE = 100 // LIKE 命中恒排 FTS bm25 命中之后、未命中之前
const stackMatch = (q) => {
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const ftsTerms = [], likeNeedles = new Set()
  for (const t of tokens) {
    if (t.length >= 3) ftsTerms.push('"' + t.replace(/"/g, '""') + '"')
    if (t.length >= 2) likeNeedles.add(t.toLowerCase())
    // CJK 长串（≥4 字）滑窗二元组——「怎么称呼我」里的「称呼」只有这里够得着
    if (/[\u4e00-\u9fff]/.test(t) && t.length >= 4) {
      for (let i = 0; i + 2 <= t.length; i++) likeNeedles.add(t.slice(i, i + 2))
    }
  }
  const needles = [...likeNeedles].slice(0, 16)
  const score = new Map()
  if (ftsTerms.length > 0) {
    try {
      const hits = db.prepare('SELECT page_id, rank FROM page_fts WHERE page_fts MATCH ? ORDER BY rank LIMIT 20')
        .all(ftsTerms.join(' OR '))
      for (const h of hits) if (!score.has(h.page_id) || h.rank < score.get(h.page_id)) score.set(h.page_id, h.rank)
    } catch { /* 非法表达式按无 FTS 命中处理 */ }
  }
  for (let i = 0; i < pages.length; i++) {
    if (score.has(i)) continue
    if (needles.some((n) => pages[i].hay.includes(n))) score.set(i, LIKE_SCORE + i * 1e-6)
  }
  return [...score.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5).map(([i]) => pages[i].rows)
}

const pairs = JSON.parse(fs.readFileSync(process.env.PM_PAIRS, 'utf8'))
const report = { rows: rows.length, pairs: [] }
for (const p of pairs) {
  const aE = likeRaw(p.exact), aP = likeRaw(p.para)
  const bE = ftsPhraseRaw(p.exact), bP = ftsPhraseRaw(p.para)
  const cE = stackMatch(p.exact).flat(), cP = stackMatch(p.para).flat()
  const hit = (top) => top.some((id) => p.expect.includes(id))
  report.pairs.push({ exact: p.exact, para: p.para, aE: hit(aE), aP: hit(aP), bE: hit(bE), bP: hit(bP), cE: hit(cE), cP: hit(cP) })
}
fs.writeFileSync(process.env.PM_REPORT, JSON.stringify(report))
`

function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-home-recall-'))
  const realDb = path.join(os.homedir(), '.pulsemind', 'db', 'pulsemind.db')
  if (!fs.existsSync(realDb)) { console.error('真实库不存在:', realDb); process.exit(1) }
  const dbCopy = path.join(home, 'copy.db')
  for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(realDb + suffix, dbCopy + suffix)

  fs.writeFileSync(path.join(home, 'phase.cjs'), PHASE)
  fs.writeFileSync(path.join(home, 'pairs.json'), JSON.stringify(QUERY_PAIRS))
  fs.writeFileSync(path.join(home, 'pages.json'), JSON.stringify(PAGES))
  const reportFile = path.join(home, 'report.json')

  const res = spawnSync(electronBin, [path.join(home, 'phase.cjs')], {
    env: {
      ELECTRON_RUN_AS_NODE: '1', HOME: home,
      NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
      PM_DB_COPY: dbCopy, PM_PAIRS: path.join(home, 'pairs.json'),
      PM_PAGES: path.join(home, 'pages.json'), PM_REPORT: reportFile,
    },
    encoding: 'utf8',
  })
  if (res.status !== 0) { console.error('phase 失败:', res.status, res.stderr); process.exit(1) }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))

  console.log(`记忆行数 ${report.rows} → 模拟 ${PAGES.length} 页；命中 = 簇内任一 rowid 进 top-5\n`)
  console.log('查询对                            A原 A改  B原 B改  C原 C改')
  for (const p of report.pairs) {
    const m = (b) => (b ? '✓' : '·')
    console.log(`${(p.exact + ' / ' + p.para).padEnd(32)} ${m(p.aE)}   ${m(p.aP)}    ${m(p.bE)}   ${m(p.bP)}    ${m(p.cE)}   ${m(p.cP)}`)
  }
  const n = report.pairs.length
  const rate = (k) => (report.pairs.filter((p) => p[k]).length / n) * 100
  const show = (k) => rate(k).toFixed(0) + '%'
  console.log(`\nA 生产LIKE: 原 ${show('aE')} 改 ${show('aP')}   B 朴素FTS: 原 ${show('bE')} 改 ${show('bP')}   C 页面栈: 原 ${show('cE')} 改 ${show('cP')}`)

  const gatePara = rate('cP') >= 70
  const gateLike = rate('cE') >= rate('aE') && rate('cP') >= rate('aP')
  console.log(`\n门1 C栈 改写 top-5 ≥70%: ${gatePara ? 'PASS' : 'FAIL'} (${show('cP')})`)
  console.log(`门2 C栈 全面 ≥ A生产LIKE: ${gateLike ? 'PASS' : 'FAIL'}`)
  console.log(gatePara && gateLike ? '\nM0a GO' : '\nM0a NO-GO（见 PLAN M0：先修检索再继续）')
  process.exit(gatePara && gateLike ? 0 : 2)
}

main()
