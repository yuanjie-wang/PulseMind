/**
 * SOP distillation settlement probe (PLAN-experience-sop 刀三) — real SQLite,
 * real store modules, no Electron window and NO LLM: the unattended run itself
 * needs a model, but the settlement half — the part that owns the database —
 * is driven here directly through `settleOutcome` (exported for exactly this):
 * the supersede promotion (files ⇒ maturity=sop, 验证证据 appended, lineage
 * kept), the declined/failed records on the clue page, and the missing-
 * deliverables refusal. Also pins the sop_ conversation-type derivation that
 * keeps run transcripts out of the extraction sweep's candidate pool.
 *
 * Same harness recipe as probe-project-color-db.mjs / probe-memory-pages-sop.mjs.
 *
 * Usage: node scripts/probe-sop-distill.mjs [--keep]
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing`)
}

async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const store = await import('../src/main/storage/memory-pages-store')
  const convDb = await import('../src/main/storage/conversation.db')
  const runner = await import('../src/main/agent/sop-runner')

  // Seed clue pages — one per settlement scenario (a promoted page's title no
  // longer resolves to a live page afterwards, so later scenarios need their own).
  const mkClue = (title) => {
    const r = store.applyPageOps([{
      action: 'create', title, type: 'experience',
      content: '## 背景\n每次发布都手动走八步。', aliases: [], links: [],
    }])
    return r[0].pageId
  }
  const clueId = mkClue('手工部署八步')
  const clueB = mkClue('部署线索B')
  const clueC = mkClue('部署线索C')
  check('fixture: clue experience pages live', [clueId, clueB, clueC].every((id) => store.getMemoryPageById(id).maturity === 'clue'))

  // ── parseSopVerdict 矩阵 ──
  const okVerdict = runner.parseSopVerdict('总结一句。\nSOP_RESULT: {"verdict":"sop","title":"部署SOP","summary":"发布流程脚本化"}')
  check('verdict=sop 解析（含 title/summary）', okVerdict?.verdict === 'sop' && okVerdict.title === '部署SOP')
  const clueVerdict = runner.parseSopVerdict('信息不足。\nSOP_RESULT: {"verdict":"clue","reason":"纯判断性工作"}')
  check('verdict=clue 解析', clueVerdict?.verdict === 'clue' && clueVerdict.reason === '纯判断性工作')
  check('无契约行 → null', runner.parseSopVerdict('普通总结，没有结果行。') === null)
  check('末行 JSON 坏 → null（不做部分猜测）', runner.parseSopVerdict('SOP_RESULT: {"verdict":sop}') === null)
  check('取最后一个 SOP_RESULT 行', runner.parseSopVerdict('SOP_RESULT: {"verdict":"clue","reason":"a"}\nSOP_RESULT: {"verdict":"sop","title":"T"}')?.verdict === 'sop')

  // ── 升格路：交付物齐全 → supersede SOP ──
  const ws = join(DATA_DIR, 'ws-sop-probe')
  mkdirSync(join(ws, 'sop', 'scripts'), { recursive: true })
  writeFileSync(join(ws, 'sop', 'page.md'), '## 前置条件\nNode 20。\n\n## 步骤\n1. 运行 deploy.mjs')
  writeFileSync(join(ws, 'sop', 'scripts', 'deploy.mjs'), 'console.log("deploy")\n')
  writeFileSync(join(ws, 'sop', 'verification.md'), 'node sop/scripts/deploy.mjs → exit 0 (x2)')
  const promoted = await runner.settleOutcome(
    clueId, '手工部署八步', ws, 'success', undefined,
    '完成。\nSOP_RESULT: {"verdict":"sop","title":"部署SOP v1","summary":"发布流程脚本化"}'
  )
  check('升格路返回 promoted + 脚本数', promoted.kind === 'promoted' && promoted.scriptCount === 1, JSON.stringify(promoted))
  const pages = store.listMemoryPages('experience')
  const sop = pages.find((p) => p.title === '部署SOP v1')
  const oldClue = store.getMemoryPageById(clueId)
  check('新 SOP 页活、带 files、maturity=sop', !!sop && !sop.supersededBy && sop.maturity === 'sop' && sop.files?.length === 1)
  check('正文带验证证据 + 诚实边界声明', !!sop && sop.body.includes('## 验证证据') && sop.body.includes('不等于复现原任务结果'))
  check('summary 落库', sop?.summary === '发布流程脚本化')
  check('旧线索页被取代（谱系留链）', oldClue?.supersededBy === sop?.id)

  // ── 放弃路：clue verdict → 固化记录、页保持 clue ──
  const declined = await runner.settleOutcome(
    clueB, '部署线索B', ws, 'success', undefined,
    'SOP_RESULT: {"verdict":"clue","reason":"纯判断性工作，没有可脚本化的步骤"}'
  )
  const afterDeclined = store.getMemoryPageById(clueB)
  check('放弃路返回 declined', declined.kind === 'declined')
  check('页保持 clue 且仍活', afterDeclineLive(afterDeclined))
  check('固化记录带原因（不带「失败」措辞）', afterDeclined.body.includes('判断不可固化：纯判断性工作') && !afterDeclined.body.includes('固化失败：纯判断性'))

  // ── 失败路：无契约行 → failed 记录 ──
  const noVerdict = await runner.settleOutcome(clueC, '部署线索C', ws, 'success', undefined, '我忘了写结果行。')
  check('缺契约 → failed 落账', noVerdict.kind === 'failed' && store.getMemoryPageById(clueC).body.includes('SOP_RESULT 行缺失'))

  // ── 失败路：verdict=sop 但交付物缺失 → 拒绝升格 ──
  const emptyWs = join(DATA_DIR, 'ws-sop-empty')
  mkdirSync(emptyWs, { recursive: true })
  const missing = await runner.settleOutcome(
    clueC, '部署线索C', emptyWs, 'success', undefined,
    'SOP_RESULT: {"verdict":"sop","title":"不该存在的页"}'
  )
  check('交付物缺失 → 拒绝升格', missing.kind === 'failed')
  check('「不该存在的页」没有落库', !store.listMemoryPages('experience').some((p) => p.title === '不该存在的页'))

  // ── status=failed：错误原因落账 ──
  const failedRun = await runner.settleOutcome(clueC, '部署线索C', ws, 'failed', '运行超时（20 分钟）', '')
  check('失败运行落账', failedRun.kind === 'failed' && store.getMemoryPageById(clueC).body.includes('固化失败：运行超时'))

  // ── 刀四：失败记账 → 资格门数据面 ──
  // （前面场景的每次非升格结算已经各记了一次——断言按增量算，不为具体值）
  const attemptsBefore = store.getMemoryPageById(clueC).sopAttempts
  store.recordSopFailedAttempt(clueC)
  store.recordSopFailedAttempt(clueC)
  const attempted = store.getMemoryPageById(clueC)
  check('recordSopFailedAttempt 递增 sop_attempts 并盖时间戳',
    attempted.sopAttempts === attemptsBefore + 2 && !!attempted.sopLastAttemptAt,
    `${attemptsBefore} → ${attempted.sopAttempts} / ${attempted.sopLastAttemptAt}`)
  const { judgeSopCandidate } = await import('../src/shared/sop-sweep')
  const gated = judgeSopCandidate({
    maturity: attempted.maturity, recurrence: attempted.recurrence,
    attempts: attempted.sopAttempts, lastAttemptAt: Date.parse(attempted.sopLastAttemptAt),
  }, Date.now())
  check('记账后的页被资格门判为 skip-retired（3 次内为 skip-backoff）',
    gated === 'skip-retired' || gated === 'skip-backoff', gated)
  check('recordSopFailedAttempt 不动 recurrence 与 maturity',
    attempted.recurrence === 0 && attempted.maturity === 'clue')

  // ── sop_ 会话类型：隐藏 + 不进提取清扫候选池 ──
  check("deriveConvType('sop_*') → routine（隐藏契约）", convDb.deriveConvType('sop_123_abc') === 'routine')
  const stamp = new Date().toISOString()
  convDb.saveConversation({
    id: 'sop_probe_run', title: '[SOP] x', createdAt: stamp, updatedAt: stamp, type: 'routine',
    messages: [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: stamp }],
  })
  convDb.saveConversation({
    id: 'conv_probe_normal', title: '普通会话', createdAt: stamp, updatedAt: stamp, type: 'normal',
    messages: [{ id: 'm2', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: stamp }],
  })
  const row = getDb().prepare("SELECT type FROM conversations WHERE id = 'sop_probe_run'").get()
  check('sop_ 行的 type 是 routine', row?.type === 'routine')
  const candidates = convDb.listMemorySweepCandidates(new Date(Date.now() + 60_000).toISOString(), 50)
  check('提取清扫候选池不含 sop_ 转写', !candidates.some((c) => c.id === 'sop_probe_run') && candidates.some((c) => c.id === 'conv_probe_normal'))
}

function afterDeclineLive(page) {
  return !!page && page.supersededBy === null && page.maturity === 'clue'
}

async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }
  const work = mkdtempSync(join(tmpdir(), 'pm-sop-distill-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'jsdom', 'playwright-core', 'chromium-bidi', 'unzipper', '@aws-sdk/client-s3'],
    plugins: [{
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
          contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} }, BrowserWindow: class {}, Notification: class { static isSupported() { return false } } }`,
          loader: 'js',
        }))
      },
    }],
    logLevel: 'warning',
  })
  console.log(`harness: ${bundle}\n`)
  const home = mkdtempSync(join(tmpdir(), 'pm-home-sop-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PM_REPO: REPO_ROOT, PM_PHASE: 'main', PM_HOME: home, PM_REPORT: report, HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let failed = payload.checks.filter((c) => !c.pass).length
  let total = payload.checks.length
  if (res.status !== 0) { failed++; console.log(`✗ phase main exited with ${res.status}`) }
  if (KEEP) console.log(`\nkept: ${work} ${home}`)
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
  launcher().catch((err) => { console.error(`\n✗ ${err?.stack || err}`); process.exit(1) })
}
