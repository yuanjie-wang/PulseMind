// PLAN-experience-scripts — real store + real SQLite end to end.
//
// Recipe: teardown probe's (esbuild bundle + ELECTRON_RUN_AS_NODE + temp HOME,
// guarded). better-sqlite3 is Electron-ABI, so the REAL store/DB half lives
// here rather than in vitest; vitest owns the gate shapes with a mock DB.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-expscripts-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

const GOOD = 'import { readFileSync } from "node:fs";\\nconst p = process.argv[2] ?? ".";\\nconsole.log(readFileSync(p, "utf8").length > 0)\\n'
const BROKEN = 'function broken() {\\n  if ('

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { ensureDataDir } = await import('./src/main/storage/index')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { experienceStore } = await import('./src/main/storage/experience-store')
  const { join } = await import('node:path')
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { EXPERIENCES_DIR } = await import('./src/main/storage/index')
  const dirOf = (name) => join(EXPERIENCES_DIR, name)

  // ── 1. save with a script: dir contents and files_json agree ──
  {
    const { record, rejectedFiles } = await experienceStore.save({
      title: '聚合导出经验',
      description: '每周聚合导出',
      content: '## 脚本 (Script)\\n\\nnode <dir>/scripts/agg.mjs <输入路径>',
      category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: GOOD }],
    })
    check('save 后 record.files 与磁盘一致', () => {
      assert.equal(rejectedFiles, undefined)
      assert.deepEqual(record.files, ['scripts/agg.mjs'])
      assert.equal(readFileSync(join(dirOf(record.name), 'scripts', 'agg.mjs'), 'utf-8'), GOOD)
    })
    check('SKILL.md 正文带脚本小节（调用命令相对形式）', () => {
      const md = readFileSync(join(dirOf(record.name), 'SKILL.md'), 'utf-8')
      assert.match(md, /## 脚本 \\(Script\\)/)
      assert.match(md, /scripts\\/agg\\.mjs/)
    })

    // list(): files + dir survive the read path (this is exactly what the
    // pick_skill envelope and the panel consume).
    const listed = experienceStore.list().find((r) => r.name === record.name)
    check('list() 还原 files 与 dir（main 计算，未入库）', () => {
      assert.deepEqual(listed.files, ['scripts/agg.mjs'])
      assert.equal(listed.dir, dirOf(record.name))
    })

    // ensureTriggers-shaped rewrite: no files in the draft → the list survives.
    await experienceStore.save({ title: '聚合导出经验', description: 'd2', content: 'v2', category: 'code', triggers: ['聚合'] })
    const after = experienceStore.list().find((r) => r.name === record.name)
    check('ensureTriggers 式回写后脚本仍在盘上、files_json 未丢', () => {
      assert.deepEqual(after.files, ['scripts/agg.mjs'])
      assert.equal(existsSync(join(dirOf(record.name), 'scripts', 'agg.mjs')), true)
    })
  }

  // ── 2. node --check gate: truncated script rejected, experience saved ──
  {
    const { record, rejectedFiles } = await experienceStore.save({
      title: '坏脚本经验',
      description: 'd',
      content: '正文',
      category: 'code',
      files: [{ path: 'scripts/broken.mjs', content: BROKEN }],
    })
    check('截断脚本被 --check 拒（rejectedFiles 回报），经验本体照常保存', () => {
      assert.deepEqual(rejectedFiles, ['scripts/broken.mjs'])
      assert.equal(record.files, undefined)
      assert.equal(existsSync(join(dirOf(record.name), 'SKILL.md')), true)
      assert.equal(existsSync(join(dirOf(record.name), 'scripts')), false)
    })
  }

  // ── 3. readFileContent jail ──
  {
    await experienceStore.save({
      title: '读取经验',
      description: 'd',
      content: 'c',
      category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: GOOD }],
    })
    check('合法路径读到内容；越界/绝对路径/不存在 → null', async () => {
      assert.equal(await experienceStore.readFileContent('读取经验', 'scripts/agg.mjs'), GOOD)
      assert.equal(await experienceStore.readFileContent('读取经验', '../settings.json'), null)
      assert.equal(await experienceStore.readFileContent('读取经验', '/etc/passwd'), null)
      assert.equal(await experienceStore.readFileContent('不存在', 'scripts/agg.mjs'), null)
    })
  }

  // ── 4. eviction removes the whole dir including scripts/ ──
  {
    // The script experience is saved FIRST (oldest, never touched → LRU head),
    // then MAX-1 plain ones + 1 more → exactly one eviction, and it must be
    // the script-bearing one.
    const { MAX_EXPERIENCES } = await import('./src/shared/types/experience-types')
    const scriptRec = (await experienceStore.save({
      title: '被淘汰的脚本经验',
      description: 'd',
      content: 'c',
      category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: GOOD }],
    })).record
    for (let i = 0; i < MAX_EXPERIENCES - 1; i++) {
      await experienceStore.save({ title: '普通经验 ' + i, description: 'd', content: 'c', category: 'general' })
    }
    const { evicted } = await experienceStore.save({ title: '压垮骆驼的新经验', description: 'd', content: 'c', category: 'general' })
    check('LRU 淘汰的是含脚本的经验，且整目录（含 scripts/）消失', () => {
      assert.equal(evicted?.name, scriptRec.name)
      assert.equal(evicted?.files?.length > 0, true)
      assert.equal(existsSync(dirOf(scriptRec.name)), false)
    })
  }

  // ── 5. iteration via targetName (PLAN-experience-iteration) ──
  {
    const { getDb } = await import('./src/main/storage/database')
    const base = await experienceStore.save({
      title: '可迭代经验',
      description: '初版描述',
      content: 'v1 正文',
      category: 'general',
      files: [{ path: 'scripts/agg.mjs', content: GOOD }],
    })
    // Backdate created_at to a sentinel so the bump is measurable: saves
    // within one second would otherwise make created_at == updated_at and
    // the "createdAt not regenerated" assertion would pass vacuously.
    // NULL content_hash also simulates a pre-upgrade row (still counts as changed).
    getDb().prepare('UPDATE experiences SET created_at = ?, updated_at = NULL, content_hash = NULL WHERE name = ?')
      .run('2020-01-01 00:00:00', base.record.name)

    const iter = await experienceStore.save({
      targetName: base.record.name,
      title: '可迭代经验（修订）',
      description: '修订描述',
      content: 'v2 修订正文 —— 合并后的完整修订稿',
      category: 'general',
    })
    const rowOf = () => experienceStore.list().find((r) => r.name === base.record.name)
    check('targetName 迭代落在同一行：id 不换、createdAt 保哨兵、不生第二行', () => {
      assert.equal(iter.record.name, base.record.name)
      assert.equal(iter.record.id, base.record.id)
      assert.equal(rowOf().createdAt, '2020-01-01 00:00:00')
      assert.equal(iter.record.title, '可迭代经验（修订）')
      // a fork would show as a second row under the revised title's slug
      const forks = experienceStore.list().filter((r) => r.title.includes('可迭代经验'))
      assert.equal(forks.length, 1)
    })
    check('updated_at 置位（离开哨兵）且写进 SKILL.md frontmatter', () => {
      const listed = rowOf()
      assert.notEqual(listed.updatedAt, null)
      assert.notEqual(listed.updatedAt, '2020-01-01 00:00:00')
      const md = readFileSync(join(dirOf(base.record.name), 'SKILL.md'), 'utf-8')
      assert.match(md, /updatedAt: /)
    })
    check('迭代后脚本 files_json 与磁盘存续（save 只写收到的文件）', () => {
      assert.deepEqual(rowOf().files, ['scripts/agg.mjs'])
      assert.equal(existsSync(join(dirOf(base.record.name), 'scripts', 'agg.mjs')), true)
    })

    // Same content again → the hash gate keeps the stamp.
    const again = await experienceStore.save({
      targetName: base.record.name,
      title: '可迭代经验（修订）',
      description: '修订描述',
      content: 'v2 修订正文 —— 合并后的完整修订稿',
      category: 'general',
    })
    check('同内容重存不 bump updated_at（哈希门）', () => {
      assert.equal(again.record.updatedAt, rowOf().updatedAt)
      assert.notEqual(again.record.updatedAt, null)
    })

    // ensureTriggers-force shape: frontmatter-only change reaches the file
    // but never reads as a second revision.
    const trig = await experienceStore.save({
      targetName: base.record.name,
      title: '可迭代经验（修订）',
      description: '修订描述',
      content: 'v2 修订正文 —— 合并后的完整修订稿',
      category: 'general',
      triggers: ['聚合', '导出'],
    })
    check('仅触发词回写：updated_at 停在原值，触发词仍落到 SKILL.md', () => {
      assert.equal(trig.record.updatedAt, rowOf().updatedAt)
      const md = readFileSync(join(dirOf(base.record.name), 'SKILL.md'), 'utf-8')
      assert.match(md, /- 聚合/)
    })
    check('迭代不算「被使用」：useCount/lastUsedAt 不动（LRU 的账另记）', () => {
      const listed = rowOf()
      assert.equal(listed.useCount, base.record.useCount)
      assert.equal(listed.lastUsedAt, base.record.lastUsedAt)
    })
  }

  console.log('PASS: ' + checks + ' checks — 脚本型经验 + 自迭代端到端成立（真 store + 真 SQLite）')
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
`
try {
  const bundle = join(work, 'probe.cjs')
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `module.exports={app:{isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}}`, loader: 'js',
      }))
    } }],
  })
  const run = spawnSync(require('electron'), [bundle], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules') },
  })
  if (run.error) throw run.error
  process.exitCode = run.status === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
