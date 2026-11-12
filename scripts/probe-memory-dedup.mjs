// PLAN-memory-extraction-dedup — hash gate / page compile layer against a REAL database.
// 2026-11-12：P2 合并层（ensureMemoryMerged）已退役，第 3 段随之改为验证接替者
// ensurePagesCompiled，并断言旧机器确实不在了——探针不再追一台停了的机器。
// 2026-11-12（同日，user 裁定）：抢救式提取（turn-end salvage）亦整体移除，第 2 段
// 同样从「验证幂等机」改为「验证它不在」——记忆提取只剩定时清扫与手动入口。
//
// Recipe: teardown probe's (esbuild bundle + ELECTRON_RUN_AS_NODE + temp HOME,
// guarded). The adapter is a counting fake — the assertions are about HOW MANY
// LLM calls a flow makes and how many rows a flow writes, which is exactly the
// currency this plan trades in.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-memdedup-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { ensureDataDir } = await import('./src/main/storage/index')
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { saveMemory, listMemories } = await import('./src/main/storage/memory.db')
  const memCount = () => getDb().prepare('SELECT COUNT(*) n FROM memories').get().n

  // ── 1. Hash gate: the same content twice → net row growth 0 ──
  {
    const before = memCount()
    saveMemory('mem_h1', '用户偏好 深色主题', 'preference', 'user_pref', null)
    saveMemory('mem_h2', '  用户偏好   深色主题  ', 'fact', 'user_pref', null) // whitespace-folded duplicate
    check('同一内容（含空白差异）两次落库 → memories 净增 1（哈希命中跳过）', () => {
      assert.equal(memCount() - before, 1)
    })
    check('不同内容照常入库', () => {
      saveMemory('mem_h3', '项目部署在华东区', 'fact', 'general', null)
      assert.equal(memCount() - before, 2)
    })
  }

  // ── 2. 抢救式提取已整体退役（user 2026-11-12：只留定时/手动提取与手动面板）──
  // 第 2 段原本验证「同料重跑 0 次 LLM」的打标幂等机。该机已删，改为验证它确实不在：
  // 运行时摸导出，而不是读注释——谁把它接回来，探针先红。
  {
    const mod = await import('./src/renderer/src/agent/engine/memory-extraction')
    check('extractMemoriesFromOldToolPairs 不再是导出', () => {
      assert.equal(mod.extractMemoriesFromOldToolPairs, undefined)
    })
    check('runTurnEndMemoryExtraction 不再是导出（唯一提取入口是定时清扫/手动）', () => {
      assert.equal(mod.runTurnEndMemoryExtraction, undefined)
    })
    check('persistUnsavedToolResults 仍在（工具结果落库没被误删）', () => {
      assert.equal(typeof mod.persistUnsavedToolResults, 'function')
    })
  }

  // ── 3. 页面编译层接住旧合并层（P2 合并机 2026-10-25 退役，语义原样移植）──
  // 旧断言测的是「归并会不会偷偷删掉用户手改行」。合并机整个消失后，这条防线换了
  // 位置：编译层压根不摸 memories 表（它只整理 memory_pages），手改行连进门的资格
  // 都没有——比「删了再保住」更强的保证，所以断言也跟着改了对象而不是删掉。
  {
    const { MemoryManager } = await import('./src/renderer/src/memory/MemoryManager')
    const { setHost } = await import('./src/renderer/src/agent/host/index')
    const store = await import('./src/main/storage/memory-pages-store')
    const { existsSync } = await import('node:fs')
    const REPO = ${JSON.stringify(root)}

    setHost({
      listMemoryPages: async () => store.listMemoryPages(),
      applyMemoryPageOps: async (ops: any) => store.applyPageOps(ops),
    } as never)

    // ① 退役证据：与其信任注释写着「已退役」，不如运行时摸一遍——最省的腐化检测。
    //    这条自身就是防御：谁把旧机器接回来，探针先红。
    const probeMm = new MemoryManager()
    check('旧合并机已退役（MemoryManager 上不再有这些方法）', () => {
      for (const m of ['ensureMemoryMerged', 'ensureMemoryCompressed', 'setMergeWatermark', 'getMergeWatermark']) {
        assert.equal(typeof (probeMm as any)[m], 'undefined', m + ' 仍在 MemoryManager 上')
      }
    })
    check('MemoryCompressionAgent.ts 已删', () => {
      assert.equal(existsSync(REPO + '/src/renderer/src/agent/one-shot-agent/MemoryCompressionAgent.ts'), false)
    })

    // ② 接住语义：同一道水位门，对象从 memories 换成活页池。灌 8 张
    //    （COMPILE_MIN_NEW）正文各不相同的页——同文会被 2026-11-12 新加的写时
    //    撞重门直接拒掉，所以正文必须互异，这不是凑数。
    const memBefore = memCount()
    for (let i = 0; i < 8; i++) {
      const r = store.applyPageOps([{ action: 'create', title: '编译页' + i, type: 'fact', content: '编译页正文 ' + i + '：' + 'x'.repeat(40) }])[0]
      if (!r.ok) throw new Error('灌页失败: ' + r.error)
    }
    let compileCalls = 0
    const mm = new MemoryManager()
    mm.setConfig('k', 'b', {} as never, 'm')
    ;(mm as any).compileAgent = { execute: async () => { compileCalls++; return { pages: [] } } }

    const ran1 = await mm.ensurePagesCompiled()
    check('水位为空且活页 ≥ COMPILE_MIN_NEW → 首次编译执行一次 LLM', () => {
      assert.equal(ran1, true) // 满目视图下空产出 = 池子干净 = 成功（不是失败重试）
      assert.equal(compileCalls, 1)
    })
    const ran2 = await mm.ensurePagesCompiled()
    check('水位后无新增且距上次 <24h → 编译 0 次 LLM 调用', () => {
      assert.equal(ran2, false)
      assert.equal(compileCalls, 1)
    })
    check('成功钟已落章（lastRunAt 推进，而非只落尝试钟）', () => {
      assert.ok(mm.getCompileWatermark().lastRunAt > 0)
    })
    check('编译层不碰 memories 表（旧合并层的删行风险随之消失）', () => {
      assert.equal(memCount(), memBefore)
    })
  }

  console.log('PASS: ' + checks + ' checks — 同一会话提取 N 次 → memories 净增 0；抢救式提取已整体退役（导出层证据）；旧合并机已退役，编译层接住水位门且不碰 memories 表')
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
