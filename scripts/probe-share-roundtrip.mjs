// probe-share-roundtrip（PLAN-share-import-export）——真 store 的导出→清空→
// 导入往返。probe-hosted-persistence.mjs 配方：本脚本用 esbuild 自 bundle
// （electron 别名为 stub，better-sqlite3 等保持 external），产物在
// ELECTRON_RUN_AS_NODE 下跑，TEMP HOME 沙盒（DATA_DIR = homedir()/.pulsemind）
// 把探针与用户数据物理隔离——无 PM_HOME 守卫拒绝运行。
//
// 断言：除 id/token/时间戳外逐字段相等；token 前后不同（剥离→normalizeTriggers
// 重铸）；重名导入落副本（「（导入）」后缀）；覆盖更新保留 id 与 createdAt；
// 工作流透传（layout 坐标保留）+ 校验失败条目拒入。
//
// 跑法：node scripts/probe-share-roundtrip.mjs [--keep]

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const KEEP = process.argv.includes('--keep')

// __filename 在 cjs bundle 里、import.meta.url 在 esm 直跑里——双形态取一。
const require_ = createRequire(process.cwd() + '/package.json')

function guardHome(home) {
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
}

async function probe() {
  const { writeFileSync } = await import('node:fs')
  const { routineStore, ROUTINES_DIR } = await import('../src/main/storage/routine-store.js')
  const { workflowStore } = await import('../src/main/storage/workflow-store.js')
  const { sanitizeRoutineForExport, buildEnvelope, parseShareFile, shareNameOf } = await import('../src/shared/share/sanitize.js')
  const home = process.env.PM_HOME

  const checks = []
  const check = (name, cond, detail = '') => {
    checks.push({ name, pass: !!cond })
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
    return !!cond
  }

  // ── 1. 造源 routine（webhook token 主进程铸造 + file 触发 + 机器路径）──
  const src = routineStore.create({
    name: '日报任务',
    description: '每天写日报',
    prompt: '写日报',
    enabled: true,
    schedule: { cron: '0 9 * * 1-5' },
    approvalMode: 'outside-ask',
    workspaceDir: '/tmp/source-workspace',
    batch: { csvPath: '/tmp/team.csv', concurrency: 3 },
    triggers: [{ type: 'webhook' }, { type: 'file', paths: ['/tmp/inbox'] }],
  })
  const srcToken = src.triggers?.[0]?.token
  check('源 routine 落库且 webhook token 主进程铸造', typeof srcToken === 'string' && srcToken.length > 0)

  // ── 2. 导出（sanitize + envelope 落盘）──
  const payload = sanitizeRoutineForExport(src)
  const envelope = buildEnvelope([{ kind: 'routine', payload }])
  const shareFile = join(home, 'share.json')
  writeFileSync(shareFile, JSON.stringify(envelope, null, 2), 'utf-8')
  const raw = (await import('node:fs')).readFileSync(shareFile, 'utf-8')
  check('分享文件不携带 token / id / 时间戳', !raw.includes(srcToken) && !raw.includes(src.id) && !raw.includes('createdAt'))

  // ── 3. 清空 → 导入（创建路径）──
  rmSync(ROUTINES_DIR, { recursive: true, force: true })
  const parsed = parseShareFile(raw)
  check('解析回 1 条 routine', parsed.items.length === 1 && parsed.items[0].kind === 'routine', JSON.stringify(parsed.errors))
  const p = parsed.items[0].payload
  const imported = routineStore.create({
    name: shareNameOf(p),
    description: typeof p.description === 'string' ? p.description : '',
    prompt: typeof p.prompt === 'string' ? p.prompt : '',
    ...(p.schedule ? { schedule: p.schedule } : {}),
    enabled: p.enabled !== false,
    ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
    ...(p.approvalMode ? { approvalMode: p.approvalMode } : {}),
    ...(p.batch ? { batch: p.batch } : {}),
    ...(Array.isArray(p.triggers) ? { triggers: p.triggers } : {}),
  })
  check('导入重铸 id', imported.id !== src.id)
  check('语义字段逐项相等（name/prompt/schedule/workspaceDir/approvalMode/batch）',
    imported.name === src.name && imported.prompt === src.prompt &&
    JSON.stringify(imported.schedule) === JSON.stringify(src.schedule) &&
    imported.workspaceDir === src.workspaceDir && imported.approvalMode === src.approvalMode &&
    JSON.stringify(imported.batch) === JSON.stringify(src.batch))
  check('file 触发路径原样保留', JSON.stringify(imported.triggers?.[1]) === JSON.stringify({ type: 'file', paths: ['/tmp/inbox'] }))
  const importedToken = imported.triggers?.[0]?.token
  check('webhook token 落库时重铸且前后不同', typeof importedToken === 'string' && importedToken.length > 0 && importedToken !== srcToken)

  // ── 4. 重名导入落副本 ──
  let dupName = shareNameOf(p)
  if (routineStore.list().some((r) => r.name === dupName)) dupName = `${dupName}（导入）`
  const dup = routineStore.create({ name: dupName, description: '', prompt: String(p.prompt), enabled: true })
  check('重名导入落副本（「（导入）」后缀）', dup.id !== imported.id && dup.name.endsWith('（导入）'))

  // ── 5. 覆盖更新保留 id 与 createdAt ──
  const before = routineStore.get(imported.id)
  const updated = routineStore.update(imported.id, { prompt: '改过的 prompt' })
  check('覆盖更新保留 id 与 createdAt', updated.id === before.id && updated.createdAt === before.createdAt && updated.prompt === '改过的 prompt')

  // ── 6. 工作流：合法透传 + 校验失败拒入 ──
  const goodWf = { id: 'wf_probe', name: '探针流水线', entry: 'a', nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'], layout: { x: 1, y: 2 } }], edges: [{ from: 'a', when: 'pass', to: 'DONE' }] }
  const wfEnv = buildEnvelope([{ kind: 'workflow', payload: goodWf }])
  const wfParsed = parseShareFile(JSON.stringify(wfEnv))
  workflowStore.save(wfParsed.items[0].payload)
  check('工作流透传（layout 坐标保留）', JSON.stringify(workflowStore.get('wf_probe')?.nodes[0]?.layout) === '{"x":1,"y":2}')
  const badWf = { ...goodWf, edges: [{ from: 'a', when: 'SKIP', to: 'DONE' }] }
  let rejected = false
  try { workflowStore.save(badWf) } catch { rejected = true }
  check('校验失败条目拒入（坏边被 validate 门拦下）', rejected && workflowStore.get('wf_probe')?.edges.length === 1)

  // ── 7. pipeline 双表真库闭环（PLAN-workflow-engine：pipeline_runs/stage_runs）──
  const { initializeDatabase } = await import('../src/main/storage/database.js')
  // db 目录由谁建：宿主侧 ensureDataDir 只建到 .pulsemind——db/ 子目录在
  // 应用启动流程里由 index.ts 建；探针里自己补齐。
  ;(await import('node:fs')).mkdirSync(join(home, '.pulsemind', 'db'), { recursive: true })
  await initializeDatabase()
  const { pipelineRunStore } = await import('../src/main/storage/pipeline-run-store.js')
  pipelineRunStore.createRun({ id: 'prun_probe', workflowId: 'wf_probe', workflowName: '探针流水线', objective: '目标', workspaceDir: '/tmp/w', status: 'running', currentNode: 'a', startedAt: new Date().toISOString() })
  pipelineRunStore.updateRun('prun_probe', { baselineCommit: 'abc123' })
  pipelineRunStore.startStage({ id: 'pstage_probe', runId: 'prun_probe', nodeId: 'a', continues: 0, startedAt: new Date().toISOString() })
  pipelineRunStore.finishStage('pstage_probe', { verdict: 'pass', conversationId: 'pipe_probe', finishedAt: new Date().toISOString(), artifacts: ['pipeline/test-failures.md'] })
  pipelineRunStore.updateRun('prun_probe', { status: 'success', currentNode: 'a', finishedAt: new Date().toISOString() })
  const runRow = pipelineRunStore.getRun('prun_probe')
  const stageRow = pipelineRunStore.listStagesOf('prun_probe')[0]
  check('pipeline_runs 行：objective/baseline/结算状态往返', runRow?.status === 'success' && runRow?.baselineCommit === 'abc123' && runRow?.objective === '目标')
  check('pipeline_stage_runs 行：verdict/会话/artifacts 往返', stageRow?.verdict === 'pass' && stageRow?.conversationId === 'pipe_probe' && JSON.stringify(stageRow?.artifacts) === '["pipeline/test-failures.md"]')
  check('listRuns 读回实例行', pipelineRunStore.listRuns().some((r) => r.id === 'prun_probe'))

  return { checks }
}

// ── harness（hosted-persistence 配方）：自 bundle + ELECTRON_RUN_AS_NODE ──
async function main() {
  const { existsSync: ex } = await import('node:fs')
  // 在 plain node 下 require('electron') 返回二进制路径字符串（不是模块）——
  // .bin/electron 壳脚本会 spawn 完整 GUI app，ELECTRON_RUN_AS_NODE 就被丢了。
  const electronBin = require_('electron')
  if (typeof electronBin !== 'string' || !ex(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }
  const work = mkdtempSync(join(tmpdir(), 'pm-share-probe-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [typeof __filename !== 'undefined' ? __filename : new URL(import.meta.url).pathname],
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-share-'))
  const report = join(work, 'probe.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PM_REPO: REPO_ROOT, PM_PHASE: 'probe', PM_HOME: home, PM_REPORT: report, HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  })
  // The child writes the report; this parent only summarizes.
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse((await import('node:fs')).readFileSync(report, 'utf-8'))
  const failed = payload.checks.filter((c) => !c.pass).length
  console.log(`\n${payload.checks.length} checks, ${failed} failed  (HOME=${home}${KEEP ? ', kept' : ''})`)
  if (!KEEP) rmSync(home, { recursive: true, force: true })
  if (!KEEP) rmSync(work, { recursive: true, force: true })
  if (failed > 0 || res.status !== 0) process.exitCode = 1
}

// Child phase: PM_PHASE set → run the probe against the sandboxed HOME.
if (process.env.PM_PHASE) {
  guardHome(process.env.PM_HOME)
  probe()
    .then(({ checks }) => {
      const { writeFileSync } = require('node:fs')
      writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks }, null, 2))
    })
    .catch((err) => {
      console.error('probe failed:', err)
      process.exit(1)
    })
} else {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
