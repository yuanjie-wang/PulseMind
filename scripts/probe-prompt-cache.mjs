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
import { homedir, tmpdir } from 'node:os'
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
    `export { BUILT_IN_TOOLS } from ${JSON.stringify(join(ROOT, 'src/renderer/src/tools/built-in-tools.ts'))}\n`
)
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: OUT, logLevel: 'silent' })
const { buildSystemPrompt, BUILT_IN_TOOLS } = await import(pathToFileURL(OUT).href)

// ── Profile ───────────────────────────────────────────────────────────
const settings = JSON.parse(readFileSync(join(homedir(), '.pulsemind/settings.json'), 'utf8'))
const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
const url = profile.baseURL.replace(/\/+$/, '') + '/chat/completions'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tools = BUILT_IN_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
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
  memoryManager: { buildMemoryContext: async () => mem },
})

const U1 = '帮我看看现在上下文的格式，我想做下优化'
const U2 = '那就先做第一步'
const XU1 = '另一个会话，完全不同的第一条消息'
const planOf = (done) => ({
  objective: '提升缓存命中率',
  mode: 'auto',
  completed: false,
  steps: [
    { description: '测出 tools 是否参与缓存', status: 'completed' },
    { description: '拆分 system prompt', status: done ? 'completed' : 'pending' },
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
async function runVariant(name, nonce, layout) {
  console.log(`\n── ${name} ──`)
  const t1 = await buildSystemPrompt({ opts: opts(nonce, MEMORY(''), '/Users/x/proj-a'), messages: [msg('u1', 'user', U1)], plan: planOf(false) })
  const t2 = await buildSystemPrompt({ opts: opts(nonce, MEMORY(MEMORY_EXTRA), '/Users/x/proj-a'), messages: [msg('u1', 'user', U1)], plan: planOf(true) })

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
  const x = await buildSystemPrompt({ opts: opts(nonce, MEMORY(''), '/Users/x/proj-b'), messages: [msg('x1', 'user', XU1)], plan: null })
  await call('other conversation', sys(x), [msg('x1', 'user', XU1), ...(block(x) ? [block(x)] : [])])

  return t2msg
}

const n = Math.random().toString(36).slice(2, 8)
const oldT2 = await runVariant('old — state inside the system prompt', 'o' + n, 'old')
const shippedT2 = await runVariant('new — shipped (state rebuilt per request)', 's' + n, 'shipped')
const persistedT2 = await runVariant('new — persisted (previous block replayed)', 'p' + n, 'persisted')

const rate = (u) => (u ? ((u.prompt_cache_hit_tokens / u.prompt_tokens) * 100).toFixed(1) + '%' : 'n/a')
console.log('\n── turn 2 (a memory was saved, a plan step completed) ──')
console.log(`  old layout             hit-rate ${rate(oldT2).padStart(6)}   uncached ${oldT2?.prompt_cache_miss_tokens ?? '-'}`)
console.log(`  new (shipped)          hit-rate ${rate(shippedT2).padStart(6)}   uncached ${shippedT2?.prompt_cache_miss_tokens ?? '-'}`)
console.log(`  new (block persisted)  hit-rate ${rate(persistedT2).padStart(6)}   uncached ${persistedT2?.prompt_cache_miss_tokens ?? '-'}`)
