/**
 * Prompt-prefix cache probe (2026-09-15). Verifies the cache contract that
 * `agent/system-prompt-builder.ts` is built around, against the live DeepSeek
 * endpoint — the one thing vitest cannot see, because "did the provider reuse my
 * prefix" is decided server-side.
 *
 * It bundles and runs the REAL builder with the REAL built-in tool definitions,
 * then measures cold hit-rates for three layouts on the turn where a memory was
 * saved and a plan step completed (the event that used to invalidate the whole
 * prompt):
 *
 *   old             state inside the system prompt (the previous design)
 *   new-persisted   invariant core + state block, previous blocks replayed in history
 *   new-shipped     invariant core + state block rebuilt per request (what ships)
 *
 * It also measures cross-conversation reuse (a new conversation with a different
 * workspace and first message), which is the point of keeping the core invariant.
 *
 * ⚠️ Unlike the other probes in this directory this one talks to the network and
 * spends the user's quota (a few thousand tokens per run, mostly cached — a
 * fraction of a cent). It reads the active profile from ~/.pulsemind/settings.json
 * and never prints the key. Run it after touching the prompt builder or the tool
 * collection, and only when you mean to pay for the measurement.
 *
 * Every prompt in a run gets a unique nonce: DeepSeek's cache is account-scoped
 * and lives for hours, so a probe without one re-hits the previous run's entries
 * and reports a warm number as if it were the result.
 *
 * Usage: node scripts/probe-prompt-cache.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-prompt-probe-')), 'builder.mjs')
const ROOT = new URL('..', import.meta.url).pathname

// ── Bundle the real builder + the real tool definitions ───────────────
const entry = join(OUT, '..', 'entry.ts')
const { writeFileSync } = await import('node:fs')
writeFileSync(
  entry,
  `export { buildSystemPrompt } from ${JSON.stringify(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'))}\n` +
    `export { BUILT_IN_TOOLS } from ${JSON.stringify(join(ROOT, 'src/renderer/src/tools/built-in-tools.ts'))}\n` +
    `export { settingsStore } from ${JSON.stringify(join(ROOT, 'src/main/storage/settings-store.ts'))}\n`
)
const stripContract = {
  name: 'strip-contract-control',
  setup(b) {
    // The A/B control for the coding contract (PLAN-coding-contract 验证门):
    // same builder, same everything, with the ONE wiring line that injects
    // ENGINEERING_WORKFLOW into the frozen core removed — so the hit-rate
    // delta between variants is exactly the contract block's effect.
    b.onLoad({ filter: /system-prompt-builder\.ts$/ }, (args) => ({
      contents: readFileSync(args.path, 'utf8').replace('parts.push(ENGINEERING_WORKFLOW)', ';'),
      loader: 'ts',
    }))
  },
}
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: OUT, logLevel: 'silent',
  // settings-store imports electron for safeStorage; the store's own fallback
  // (unavailable → plaintext) is exactly what a plaintext settings file needs.
  plugins: [
    {
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
          contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)} }, safeStorage: { isEncryptionAvailable: () => false, decryptString: (v) => v } }`, loader: 'js',
        }))
      },
    },
  ],
})
const { buildSystemPrompt, BUILT_IN_TOOLS, settingsStore } = await import(pathToFileURL(OUT).href)

// Second bundle for the sans-contract control (a plugin is per-build, and the
// first bundle must stay pristine).
const OUT2 = join(OUT, '..', 'builder-sans.mjs')
const entry2 = join(OUT, '..', 'entry-sans.ts')
writeFileSync(
  entry2,
  `export { buildSystemPrompt } from ${JSON.stringify(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'))}\n`
)
await build({ entryPoints: [entry2], bundle: true, format: 'esm', platform: 'node', outfile: OUT2, logLevel: 'silent', plugins: [stripContract] })
const { buildSystemPrompt: buildSystemPromptSans } = await import(pathToFileURL(OUT2).href)

// ── Profile ───────────────────────────────────────────────────────────
// Through the REAL store: since the 2026-09-25 two-layer migration the file on
// disk is provider-shaped and `settings.profiles` exists only in the store's
// derived view — the old raw-JSON read finds nothing.
const settings = await settingsStore.get()
const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
if (!profile) {
  console.log('no active profile resolved from settings.json — nothing to probe')
  process.exit(1)
}
if ((profile.provider ?? 'openai') !== 'openai') {
  console.log(`active profile apiFormat is "${profile.provider}" — this probe speaks the OpenAI-compatible shape only`)
  process.exit(1)
}
const url = profile.baseURL.replace(/\/+$/, '') + '/chat/completions'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tools = BUILT_IN_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))
console.log(`model: ${profile.model}  tools: ${tools.length} (${JSON.stringify(tools).length} chars)\n`)

const MEMORY = (extra) => `# Memory Context
## Manual Memories
用户偏好简洁的技术回答，不要客套。
## Extracted Memories
- 项目 PulseMind 使用 esbuild + Vite 双构建
- 主进程通过 require() 解析依赖，不做打包${extra}
## Recent Conversations
<guide>If needed, you can use the ID to trigger conversation_search to retrieve the conversation records.</guide>
<data>
|id|keywords|
conv_1777|缓存优化讨论|
</data>`
const MEMORY_EXTRA = '\n- 工具定义参与 DeepSeek 前缀缓存，必须保持稳定'

const opts = (nonce, mem, workspace) => ({
  apiKey: null,
  baseURL: profile.baseURL,
  model: profile.model,
  maxTokens: 4096,
  myName: 'Yuanjie',
  soul: `terse, technical [run:${nonce}]`,
  yourName: 'Pulse',
  locale: 'zh',
  workspaceDir: workspace,
  // 2026-09-26: the memory context rides the FROZEN CORE behind the two-clock
  // TTL, delivered through getStableMemoryContext (the old buildMemoryContext
  // stub silently produced a core with no memory section at all).
  memoryManager: { getStableMemoryContext: async () => mem },
})

const U1 = '帮我看看现在上下文的格式，我想做下优化'
const U2 = '那就先做第一步'
const XU1 = '另一个会话，完全不同的第一条消息'
const planOf = (done) => ({
  objective: '提升缓存命中率',
  mode: 'auto',
  completed: false,
  version: 2,
  nodes: [
    { id: 'n1', description: '测出 tools 是否参与缓存', status: 'completed', dependsOn: [] },
    { id: 'n2', description: '拆分 system prompt', status: done ? 'completed' : 'pending', dependsOn: ['n1'] },
  ],
})

const msg = (id, role, text) => ({ id, role, contentBlocks: [{ type: 'text', text }], createdAt: '2026-09-15T00:00:00.000Z' })
const wire = (m) => ({ role: m.role, content: m.contentBlocks.map((b) => b.text ?? '').join('\n') })
const post = (text) => (text ? [msg('a1', 'assistant', text)] : [])

async function call(label, system, messages) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey },
    body: JSON.stringify({
      model: profile.model,
      max_tokens: 24,
      stream: false,
      tools,
      messages: [{ role: 'system', content: system }, ...messages.map(wire)],
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    console.log(`${label.padEnd(24)} ERROR ${res.status} ${JSON.stringify(json).slice(0, 160)}`)
    return null
  }
  const u = json.usage
  const hit = u.prompt_cache_hit_tokens ?? 0
  console.log(
    `${label.padEnd(24)} prompt=${String(u.prompt_tokens).padStart(5)}  hit=${String(hit).padStart(5)}  miss=${String(u.prompt_cache_miss_tokens).padStart(5)}  hit-rate=${((hit / u.prompt_tokens) * 100).toFixed(1)}%`
  )
  return { ...u, text: json.choices?.[0]?.message?.content ?? '' }
}

/** Prime turn 1, confirm warmth, move the volatile state, then open a new conversation. */
async function runVariant(name, nonce, layout, builder = buildSystemPrompt) {
  console.log(`\n── ${name} ──`)
  const t1 = await builder({ opts: opts(nonce, MEMORY(''), '/Users/x/proj-a'), messages: [msg('u1', 'user', U1)], plan: planOf(false) })
  const t2 = await builder({ opts: opts(nonce, MEMORY(MEMORY_EXTRA), '/Users/x/proj-a'), messages: [msg('u1', 'user', U1)], plan: planOf(true) })

  const fold = (core, state) => `${core}\n\n${state.replace(/^<session-state>\n|\n<\/session-state>$/g, '')}`
  const sys = (r) => (layout === 'old' ? fold(r.systemPrompt, r.stateBlock) : r.systemPrompt)
  const block = (r) => (layout === 'old' ? null : msg('s', 'user', r.stateBlock))

  await call('turn 1 (prime)', sys(t1), [msg('u1', 'user', U1), ...(block(t1) ? [block(t1)] : [])])
  await sleep(12000) // cache construction "takes seconds"
  const warm = await call('turn 1 (warm)', sys(t1), [msg('u1', 'user', U1), ...(block(t1) ? [block(t1)] : [])])

  await sleep(2000)
  const history = [
    msg('u1', 'user', U1),
    ...(layout === 'persisted' && block(t1) ? [block(t1)] : []),
    ...post(warm?.text),
    msg('u2', 'user', U2),
  ]
  const t2msg = await call('turn 2 (state moved)', sys(t2), block(t2) ? [...history, block(t2)] : history)

  // Cross-conversation: different workspace, different first message, same app state.
  await sleep(2000)
  const x = await builder({ opts: opts(nonce, MEMORY(''), '/Users/x/proj-b'), messages: [msg('x1', 'user', XU1)], plan: null })
  await call('other conversation', sys(x), [msg('x1', 'user', XU1), ...(block(x) ? [block(x)] : [])])

  return t2msg
}

const n = Math.random().toString(36).slice(2, 8)
const oldT2 = await runVariant('old — state inside the system prompt', 'o' + n, 'old')
const shippedT2 = await runVariant('new — shipped (state rebuilt per request)', 's' + n, 'shipped')
const persistedT2 = await runVariant('new — persisted (previous block replayed)', 'p' + n, 'persisted')
const sansT2 = await runVariant('control — shipped WITHOUT the coding contract block', 'c' + n, 'shipped', buildSystemPromptSans)

const rate = (u) => (u ? ((u.prompt_cache_hit_tokens / u.prompt_tokens) * 100).toFixed(1) + '%' : 'n/a')
console.log('\n── turn 2 (a memory was saved, a plan step completed) ──')
console.log(`  old layout             hit-rate ${rate(oldT2).padStart(6)}   uncached ${oldT2?.prompt_cache_miss_tokens ?? '-'}`)
console.log(`  new (shipped)          hit-rate ${rate(shippedT2).padStart(6)}   uncached ${shippedT2?.prompt_cache_miss_tokens ?? '-'}`)
console.log(`  new (block persisted)  hit-rate ${rate(persistedT2).padStart(6)}   uncached ${persistedT2?.prompt_cache_miss_tokens ?? '-'}`)
console.log(`  shipped, no contract   hit-rate ${rate(sansT2).padStart(6)}   uncached ${sansT2?.prompt_cache_miss_tokens ?? '-'}`)
