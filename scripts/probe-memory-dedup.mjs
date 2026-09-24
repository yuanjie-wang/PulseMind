// PLAN-memory-extraction-dedup — hash gate / merge layer against a REAL database.
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

  // ── 2. Salvage marking: real module + counting adapter ──
  {
    const { extractMemoriesFromOldToolPairs } = await import('./src/renderer/src/agent/engine/memory-extraction')
    const messages = []
    for (let i = 0; i < 4; i++) { // 4 pairs: the tail guard leaves exactly 2 eligible → both mined in run 1
      messages.push({ id: 'a' + i, role: 'assistant', contentBlocks: [{ type: 'text', text: 'reasoning ' + i }, { type: 'tool_use', name: 'read', id: 't' + i }] })
      messages.push({ id: 'u' + i, role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'result ' + i }] })
    }
    let calls = 0
    const engine = {
      messages, spawnSystemPrompt: null,
      opts: { conversationId: 'conv_probe', contextLength: 128000, apiKey: 'k', baseURL: 'b', model: 'm',
        adapter: { callNonStreaming: async () => { calls++; return '[]' } } },
      compactor: { contextTokens: () => 200000 },
    }
    await extractMemoriesFromOldToolPairs(engine)
    const firstCalls = calls
    const firstMarked = messages.filter((m) => m.memExtracted).length
    await extractMemoriesFromOldToolPairs(engine)
    const secondCalls = calls - firstCalls
    check('回合末提取真跑一次 LLM 并给对打标（' + firstMarked + ' 条消息带 memExtracted）', () => {
      assert.equal(firstCalls, 1)
      assert.equal(firstMarked, 4)
    })
    check('已标记的对不会被重挖（同料重跑 → 0 次内部 LLM 调用）', () => {
      assert.equal(secondCalls, 0)
    })
  }

  // ── 3. P2 merge: user-edited rows survive; watermark gates re-runs ──
  {
    const { MemoryManager } = await import('./src/renderer/src/memory/MemoryManager')
    const { setHost } = await import('./src/renderer/src/agent/host/index')
    const memDb = await import('./src/main/storage/memory.db')
    const { memoryContentHash } = await import('./src/shared/memory/content-hash')
    setHost({
      listMemories: async (category?: string) => memDb.listMemories(category).map((r: any) => ({
        id: r.id, content: r.content, type: r.type, category: r.category, source: r.source,
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      saveMemory: async (input: any) => { memDb.saveMemory(input.id ?? 'mem_x', input.content, input.type ?? 'auto', input.category ?? 'general', input.source ?? null); return input },
      deleteMemory: async (id: string) => { memDb.deleteMemory(id) },
      countMemories: async () => memDb.countMemoriesByType(['auto', 'fact', 'decision', 'preference']),
    } as never)
    // keep the memory rows' hashes in sync with what the merge deletes by
    const mm = new MemoryManager()

    // Seed: one user-edited memory (updated_at > created_at) + several auto rows
    const db = getDb()
    db.prepare("INSERT INTO memories (id, content, type, category, source, created_at, updated_at, content_hash) VALUES ('mem_user', '手改的关键事实', 'fact', 'general', NULL, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', ?)").run(memoryContentHash('手改的关键事实'))
    for (let i = 0; i < 6; i++) {
      db.prepare('INSERT INTO memories (id, content, type, category, source, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('mem_auto' + i, '自动记忆条目 ' + i + '：部署细节', 'auto', 'general', null, '2026-09-03T0' + i + ':00:00Z', '2026-09-03T0' + i + ':00:00Z', memoryContentHash('自动记忆条目 ' + i + '：部署细节'))
    }

    // Config the manager with a counting fake adapter whose merge output
    // deliberately DROPS the user-edited row — the code must keep it anyway.
    let mergeCalls = 0
    mm.setConfig('k', 'b', { callNonStreaming: async () => { mergeCalls++; return '[]' } }, 'm')
    ;(mm as any).compressionAgent = {
      execute: async () => {
        mergeCalls++
        return [
          { content: '合并后的部署细节记忆', type: 'fact', category: 'general' },
          { content: '另一条合并记忆：备份策略为每周全量', type: 'fact', category: 'general' },
        ]
      },
    }

    // First run: watermark empty → due (added = all) → merge runs.
    const ran1 = await mm.ensureMemoryMerged()
    check('水位为空 → 首次合并执行一次 LLM', () => {
      assert.equal(ran1, true)
      assert.equal(mergeCalls, 1)
    })
    check('用户手改行在合并后原样保留（旧的全删重写会静默丢掉它）', () => {
      const row = db.prepare("SELECT content FROM memories WHERE id = 'mem_user'").get()
      assert.ok(row, 'user-edited row survives')
      assert.equal(row.content, '手改的关键事实')
    })
    check('被合并的自动行被清理（保留手改行 + 合并产物）', () => {
      const autoLeft = db.prepare("SELECT COUNT(*) n FROM memories WHERE id LIKE 'mem_auto%'").get().n
      assert.equal(autoLeft, 0)
      assert.ok(db.prepare('SELECT COUNT(*) n FROM memories').get().n >= 3)
    })

    // Second run immediately: watermark advanced + <24h → no LLM call at all.
    const ran2 = await mm.ensureMemoryMerged()
    check('水位后无新增且距上次 <24h → 合并 0 次 LLM 调用', () => {
      assert.equal(ran2, false)
      assert.equal(mergeCalls, 1)
    })

    // Watermark round-trip helpers exist for the main-process persistence.
    mm.setMergeWatermark({ lastRunAt: 12345, lastCount: 7 })
    const w = mm.getMergeWatermark()
    check('水位可读回（session-manager 持久化到 settings.json 的形状）', () => {
      assert.deepEqual(w, { lastRunAt: 12345, lastCount: 7 })
    })
  }

  console.log('PASS: ' + checks + ' checks — 同一会话提取 N 次 → memories 净增 0；loop 内提取调用 = 0；合并层保住手改行')
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
