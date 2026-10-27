#!/usr/bin/env node
// 记忆迁移真库探针（PLAN-memory-wiki M5，2026-10-25）：临时 HOME 沙箱里跑真
// initializeDatabase + 真迁移函数，钉三件事——
//   ① 经验池字节平移：SKILL.md 正文/脚本原样进页（无 LLM、零改写）；
//   ② 幂等：重跑零变化（确定性 id + settings 旗标语义）；
//   ③ 旧表冻结：experiences/memories 原行原样保留（回滚面）。
// recipe 同 probe-memory-pages-db.mjs。
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return !!pass
}
function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to touch the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} outside PM_HOME`)
}

const EXP_MD = `---
name: probe-exp
title: 探针经验
description: 迁移探针
category: general
---
## 背景
迁移验证。

## 过程
1. 建页 2. 平移

### File: scripts/run.mjs
\`\`\`js
console.log('probe-exp-script')
\`\`\`
`

async function phaseMigrate() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  // 旧形状种子：experiences 表一行 + SKILL.md + scripts 文件 + files_json
  mkdirSync(join(DATA_DIR, 'experiences', 'probe-exp', 'scripts'), { recursive: true })
  writeFileSync(join(DATA_DIR, 'experiences', 'probe-exp', 'SKILL.md'), EXP_MD, 'utf-8')
  db.prepare(`INSERT INTO experiences (id, name, title, description, category, source_conversation_id, created_at, last_used_at, use_count, triggers, files_json)
    VALUES ('exp_probe_1', 'probe-exp', '探针经验', '迁移探针', 'general', 'conv_x', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', 7, '["触发词A"]', ?)`)
    .run(JSON.stringify([{ path: 'scripts/run.mjs', content: "console.log('probe-exp-script')" }]))
  db.prepare(`INSERT INTO memories (id, content, type, category, source, created_at, updated_at, content_hash)
    VALUES ('mem_probe_1', '用户偏好短句回答。', 'preference', 'user_pref', NULL, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'h1')`).run()
  db.prepare(`INSERT INTO memories (id, content, type, category, source, created_at, updated_at, content_hash)
    VALUES ('mem_probe_2', 'legacy 经验行', 'experience', 'experience', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'h2')`).run()

  const { migrateExperiencesToPages, listFlatMemoriesForMigration, fallbackFlatMemoryOps, applyFlatMemoryMigration } = await import('../src/main/services/memory-migration')
  const { listMemoryPages, getMemoryPageById } = await import('../src/main/storage/memory-pages-store')

  const expCount = migrateExperiencesToPages()
  check('经验池平移：1 条成页', expCount === 1)
  const page = listMemoryPages('experience').find((p) => p.title === '探针经验')
  check('确定性 id（page_mig_exp_*）', !!page && page.id === 'page_mig_exp_exp_probe_1', page?.id)
  check('正文字节平移（frontmatter 剥离、四节与脚本围栏原样）', !!page && page.body.includes('## 背景') && page.body.includes('### File: scripts/run.mjs') && page.body.includes("console.log('probe-exp-script')"))
  check('别名种子 = name + triggers + use_count 平移', !!page && page.aliases.includes('probe-exp') && page.aliases.includes('触发词A') && page.useCount === 7)
  check('files 平移', !!page && page.files?.length === 1 && page.files[0].path === 'scripts/run.mjs')

  // 扁平记忆兜底臂
  const flat = listFlatMemoriesForMigration()
  check('扁平源只含非 experience 行（legacy 行排除）', flat.length === 1 && flat[0].id === 'mem_probe_1', JSON.stringify(flat.map((f) => f.id)))
  const n = applyFlatMemoryMigration(fallbackFlatMemoryOps(flat))
  check('扁平记忆落页（确定性 id）', n === 1 && getMemoryPageById('page_mig_mem_mem_probe_1')?.body === '用户偏好短句回答。')

  // 幂等：重跑 → 页内容零变化
  const before = JSON.stringify(listMemoryPages())
  migrateExperiencesToPages()
  applyFlatMemoryMigration(fallbackFlatMemoryOps(listFlatMemoriesForMigration()))
  check('幂等：重跑零变化', JSON.stringify(listMemoryPages()) === before)

  // 旧表冻结
  check('experiences 表原行保留（冻结）', db.prepare("SELECT COUNT(*) AS c FROM experiences WHERE id='exp_probe_1'").get().c === 1)
  check('memories 表原行保留（含 legacy 行）', db.prepare('SELECT COUNT(*) AS c FROM memories').get().c === 2)
  check('SKILL.md 磁盘文件保留（冻结）', existsSync(join(DATA_DIR, 'experiences', 'probe-exp', 'SKILL.md')))
}

async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  const work = mkdtempSync(join(tmpdir(), 'pm-memory-migration-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'jsdom', 'playwright-core', 'chromium-bidi'],
    plugins: [{
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
          contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`, loader: 'js',
        }))
      },
    }],
    logLevel: 'warning',
  })
  const home = mkdtempSync(join(tmpdir(), 'pm-home-migration-'))
  const report = join(work, 'report.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PM_REPO: REPO_ROOT, PM_PHASE: 'migrate', PM_HOME: home, PM_REPORT: report, HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf8'))
  const failed = payload.checks.filter((c) => !c.pass).length + (res.status === 0 ? 0 : 1)
  console.log(`\n${payload.checks.length - failed + (res.status === 0 ? 0 : 0)}/${payload.checks.length} checks passed${res.status !== 0 ? ' (phase exited non-zero)' : ''}`)
  if (!process.argv.includes('--keep')) { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  phaseMigrate()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => { console.error(`✗ phase threw: ${err?.stack || err}`); process.exit(1) })
} else {
  launcher().catch((err) => { console.error(err?.stack || err); process.exit(1) })
}
