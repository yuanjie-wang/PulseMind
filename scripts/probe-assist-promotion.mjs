/**
 * Form-assist promotion probe (real SQLite, real main-process modules, the
 * real renderer lifecycle module — no Electron window, no LLM).
 *
 * 升格 (user ruling 2026-09-20) hands a create-flow's draft thread to the entity
 * the form just created. The first version re-persisted the mirror under the
 * RAW entity id — `expert_<slug>` / `routine_<hash>` — which broke the thread in
 * the two ways the user reported as one sentence
 * 「用助手创建专家的对话出现在了历史对话列表中，而且内容不可见」:
 *   ① `deriveConvType('<bare slug>')` is 'normal', so the row is a chat in the
 *      sidebar; and
 *   ② `messages.id` is a global key whose owner is write-once (the upsert behind
 *      saveConversation deliberately never rewrites `conversation_id`), so
 *      re-saving the draft's own ids left every row owned by the DRAFT slot —
 *      the promoted conversation inserted with zero messages, and the editor
 *      re-bound to a slot holding nothing.
 * The fix derives the target from the spec's prefix (`formAssistConversationId`)
 * and re-keys the thread for its new owner, so the promotion is a real move.
 *
 * Section ② runs the PRE-FIX shape by hand against the same thread and measures
 * the defect on a real database: that is this probe's non-vacuity control, and
 * the reason it is worth a probe at all is that vitest cannot open the database
 * (better-sqlite3 here is built for Electron's ABI). Recipe as in
 * scripts/probe-conversation-teardown.mjs: esbuild bundle (`platform: node`,
 * `packages: 'external'` so a bare import is resolved at runtime from NODE_PATH
 * instead of being walked — the main-side module graph reaches playwright-core
 * and jsdom, and bundling those is both pointless and unbuildable today,
 * chromium-bidi not being installed — `electron` aliased to a stub because
 * `require('electron')` outside a running app returns a string), executed by
 * the Electron binary in ELECTRON_RUN_AS_NODE mode, `HOME` pointed at a fresh
 * temp directory so `~/.pulsemind` (the user's real data) is never opened.
 * `guardHome` refuses to start otherwise.
 *
 * Usage: node scripts/probe-assist-promotion.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

// ── reporting ──────────────────────────────────────────────────────────────
const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

/** Never let a phase touch anything but its own temp HOME. */
function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing to touch it`)
}

// ── the one phase · promote / discard against a real database ──────────────
async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  const {
    saveConversation,
    deleteConversation,
    getConversation,
    hydrateConversation,
    listConversations,
    deriveConvType,
  } = await import('../src/main/storage/conversation.db')
  const { promoteAssistDraftToEntity, discardAssistConversation } =
    await import('../src/renderer/src/components/form-assist/session-lifecycle')
  const { agentMessagesToConversation } = await import('../src/renderer/src/utils/message-utils')

  // The IPC boundary minus the transport: saveConversation / deleteConversation
  // ARE the handler bodies (conversation.handler's pass/void wrappers), and
  // dispose rejects like a session nothing was ever sent to — which is also the
  // discard's tolerance path.
  globalThis.window = {
    electronAPI: {
      agentSessionEngineCall: () => Promise.reject(new Error('no live session')),
      deleteConversation: (id) => Promise.resolve().then(() => deleteConversation(id)),
      saveConversation: (conv) => Promise.resolve().then(() => saveConversation(conv)),
    },
  }

  const t0 = '2026-09-21T06:55:00.000Z'
  const t1 = '2026-09-21T06:55:30.000Z'
  const title = '[专家创建助手] 演示专家'
  // The mirror the editor holds at save time: a user ask and the assistant's
  // reply carrying a tool_result block (whose CONTENT lives in tool_results).
  const thread = [
    { id: 'msg_draft_1', role: 'user', contentBlocks: [{ type: 'text', text: '帮我建一个做 PPT 的专家' }], createdAt: t0 },
    {
      id: 'msg_draft_2',
      role: 'assistant',
      contentBlocks: [
        { type: 'text', text: '好的，已按你的要求拟好草稿。' },
        { type: 'tool_result', tool_use_id: 'tu_1', tool_result_id: 'tr_1', content: '{"ok":true}', is_error: false },
      ],
      createdAt: t1,
    },
  ]

  // ── ① the state the promote starts from: the draft slot owns the thread ──
  saveConversation(agentMessagesToConversation(thread, 'expert_assist_draft', title))
  check('the draft slot holds the thread', getConversation('expert_assist_draft')?.messages.length === 2)
  // A plain chat, so the sidebar filter has something to match — the promoted
  // thread's absence below must not pass because the list is empty.
  saveConversation(
    agentMessagesToConversation(
      [{ id: 'msg_normal_1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: t0 }],
      'conv_probe_normal',
      '普通对话'
    )
  )

  // ── ② the pre-fix shape, measured: re-persist on the RAW entity id ──
  saveConversation(agentMessagesToConversation(thread, 'expert_probe_old', title))
  const oldRow = db.prepare('SELECT type FROM conversations WHERE id = ?').get('expert_probe_old')
  check("pre-fix: the row's type is 'normal' (deriveConvType of a bare id)", oldRow?.type === 'normal', oldRow?.type)
  // 2026-11-04 起 listConversations 滤掉零消息行，所以这条 pre-fix 残留只剩
  // 「行存在、内容不可见、也进不了历史对话」——修复要做的事（绝不写裸 id）
  // 仍由 ③ 的后续几条钉住。
  check('pre-fix: …and the zero-message row never surfaces in 历史对话', !listConversations().some((c) => c.id === 'expert_probe_old'))
  const oldConv = getConversation('expert_probe_old')
  check('pre-fix: with ZERO messages — 内容不可见', oldConv?.messages.length === 0, `${oldConv?.messages.length} msgs`)
  check('pre-fix: the text is still owned by the draft slot', getConversation('expert_assist_draft')?.messages.length === 2)
  // The ref_id-keyed table DID move: that difference is exactly why the message
  // rows cannot follow by copying — the id-keyed upsert keeps its owner.
  check(
    'pre-fix: the tool_result row followed the last writer (ref_id-keyed)',
    db.prepare('SELECT conversation_id FROM tool_results WHERE ref_id = ?').get('tr_1')?.conversation_id === 'expert_probe_old'
  )

  // ── ③ the fix: promote onto the entity's SLOT, as the editors do ──
  await promoteAssistDraftToEntity(thread, 'expert', 'expert_assist_draft', 'expert_probe', title)
  const row = db.prepare('SELECT type, title FROM conversations WHERE id = ?').get('expert_assist_expert_probe')
  check('the target is the derived SLOT id', !!row, 'expert_assist_expert_probe')
  check("its type is 'expert' — an assist thread, not a chat", row?.type === 'expert', row?.type)
  const listed = listConversations()
  check('a normal conversation is still listed (the filter is live)', listed.some((c) => c.id === 'conv_probe_normal'))
  check('the promoted thread is NOT in 历史对话', !listed.some((c) => c.id === 'expert_assist_expert_probe'))
  check('the bare entity id was never written', getConversation('expert_probe') === null)

  // Read back through the editors' own path (hydrateConversation fills the
  // tool_result blocks from the table).
  const stored = hydrateConversation('expert_assist_expert_probe')
  check('the whole thread is readable', stored?.messages.length === 2, `${stored?.messages.length} msgs`)
  check('the user ask survived', stored?.messages[0]?.content.includes('做 PPT 的专家'), stored?.messages[0]?.content)
  check('the assistant reply survived', stored?.messages[1]?.content.includes('拟好草稿'))
  const trBlock = stored?.messages[1]?.contentBlocks?.find((b) => b.type === 'tool_result')
  check('the tool result content came back through hydrate', trBlock?.content === '{"ok":true}', trBlock?.content)
  check(
    'the tool_result row now points at the promoted thread',
    db.prepare('SELECT conversation_id FROM tool_results WHERE ref_id = ?').get('tr_1')?.conversation_id === 'expert_assist_expert_probe'
  )
  const ids = stored?.messages.map((m) => m.id) ?? []
  check('every message was re-keyed for its new owner', ids.every((id) => id.startsWith('msg_expert_assist_expert_probe_')), ids.join(', '))
  check('…once each (no duplicated thread)', new Set(ids).size === 2 && ids.length === 2)
  check('…and no key is the draft’s', !ids.includes('msg_draft_1') && !ids.includes('msg_draft_2'))

  // ── ④ the discard took the old rows with it ──
  check('the draft row is gone', getConversation('expert_assist_draft') === null)
  const orphanMsgs = db.prepare('SELECT COUNT(*) n FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL').get().n
  const orphanTrs = db.prepare('SELECT COUNT(*) n FROM tool_results t LEFT JOIN conversations c ON c.id = t.conversation_id WHERE c.id IS NULL').get().n
  check('no orphaned message rows left behind', orphanMsgs === 0, `${orphanMsgs} orphan(s)`)
  check('no orphaned tool_result rows left behind', orphanTrs === 0, `${orphanTrs} orphan(s)`)
  check('the pre-fix junk row is exactly the artifact the report describes', getConversation('expert_probe_old')?.messages.length === 0)

  // ── ⑤ the two derivations the editors rely on agree ──
  const { formAssistConversationId } = await import('../src/renderer/src/components/form-assist/form-assist')
  check(
    "the editors' re-bind slot IS the promoted slot",
    formAssistConversationId('expert', 'expert_probe') === 'expert_assist_expert_probe'
  )
  check("a bare id derives 'normal' — the whole mechanism, named", deriveConvType('expert_probe') === 'normal')
  check('the routine prefix lands on its own slot too', deriveConvType(formAssistConversationId('routine', 'routine_x')) === 'routine')

  // ── ⑥ the discard is still the dispose-then-delete pair ──
  const order = []
  globalThis.window.electronAPI.agentSessionEngineCall = () => { order.push('dispose'); return Promise.reject(new Error('absent')) }
  globalThis.window.electronAPI.deleteConversation = (id) => { order.push(`delete:${id}`); return Promise.resolve() }
  await discardAssistConversation('expert_assist_ghost')
  check('a ghost discard disposes first, then deletes, tolerating both absences', order.join(' ').startsWith('dispose delete:expert_assist_ghost'), order.join(' '))
}

// ── runner ─────────────────────────────────────────────────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-assist-promotion-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild'],
    packages: 'external',
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
  console.log(`harness: ${bundle}\n`)

  const home = mkdtempSync(join(tmpdir(), 'pm-home-assist-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'main',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let total = payload.checks.length
  let failed = payload.checks.filter((c) => !c.pass).length
  if (res.error || res.status !== 0) { failed++; console.log(`  ✗ phase main exited with ${res.status ?? res.error}`) }

  // The wiring the phase cannot see: it calls the promote itself, with the fix's
  // signature. If an editor stops passing the prefix, or the sidebar's delete
  // stops going through deleteConversation, the probe above stays green while
  // the app regresses — so those three facts are scanned here.
  console.log('\n⑦ the app drives exactly this path')
  const src = (p) => readFileSync(join(REPO_ROOT, ...p), 'utf-8')
  const lifecycleSrc = src(['src', 'renderer', 'src', 'components', 'form-assist', 'session-lifecycle.ts'])
  const expertSrc = src(['src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertEditor.tsx'])
  const routineSrc = src(['src', 'renderer', 'src', 'components', 'routine', 'RoutineEditorPage.tsx'])
  const handlerSrc = src(['src', 'main', 'ipc', 'conversation.handler.ts'])
  const wired = [
    ['session-lifecycle derives the target with formAssistConversationId', /const convId = formAssistConversationId\(conversationPrefix, entityId\)/.test(lifecycleSrc) && lifecycleSrc.length > 500, `${lifecycleSrc.length} chars`],
    ['session-lifecycle re-keys the messages it saves', /rekeyed/.test(lifecycleSrc) && /crypto\.randomUUID\(\)/.test(lifecycleSrc)],
    ['ExpertEditor promotes with EXPERT_ASSIST_SPEC.conversationPrefix', /promoteAssistDraftToEntity\(\s*assist\.messages,\s*EXPERT_ASSIST_SPEC\.conversationPrefix,/.test(expertSrc)],
    ['RoutineEditorPage promotes with ROUTINE_ASSIST_SPEC.conversationPrefix', /promoteAssistDraftToEntity\(\s*assist\.messages,\s*ROUTINE_ASSIST_SPEC\.conversationPrefix,/.test(routineSrc)],
    // The handler grew the autoCleanup deleteWorkspace arm (workspace first, row
    // second), so the voidHandler shape no longer describes it; the intent —
    // the sidebar's delete goes through this channel and ends in
    // deleteConversation — is what the pin keeps.
    ['the sidebar delete is the CONVERSATION_DELETE handler over deleteConversation', /IPC_CHANNELS\.CONVERSATION_DELETE, async \(_event, id: string, opts\?: \{ deleteWorkspace\?: boolean \}\)[\s\S]{0,400}?deleteConversation\(id\)/.test(handlerSrc), ''],
  ]
  for (const [name, ok, detail] of wired) check(name, ok, detail)
  total += wired.length
  failed += wired.filter(([, ok]) => !ok).length

  if (KEEP) console.log(`\nkept: ${home} ${work}`)
  else { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }) }

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
  launcher().catch((err) => {
    console.error(`✗ launcher threw: ${err?.stack || err}`)
    process.exit(1)
  })
}
