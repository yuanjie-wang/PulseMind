/**
 * Real-browser render of the form-assist 自动填入 pipeline (user ruling
 * 2026-09-20: 「不要草稿模式，生成结论后直接填入表单，给撤销按钮」) — the
 * routine editor's REAL form column + REAL assistant column wired through the
 * REAL useFormAssistSession, with the hosted session stubbed at the electronAPI
 * seam so the probe drives the same events the main process emits.
 *
 * The 2026-09-19 probe guarded the review card (diff rows, checkboxes,
 * dismiss/restore). That card is GONE by ruling; what must hold now:
 *
 *   · a completed reply's patch lands in the form by itself (no apply click),
 *     the undo bar names it, and no checkbox/review card resurfaces;
 *   · 撤销 restores the form to the state captured at that apply — including
 *     manual edits made between applies;
 *   · the trigger is fire-once per message change: a same-message mutation
 *     (message_stats / a re-delivered identical list) never re-applies, and a
 *     prose reply retires the undo bar without touching the form;
 *   · hydrated history RECORDS WITHOUT FIRING — a restored conversation must
 *     not pour its old conclusions over a freshly loaded form;
 *   · the render strips stay honest (user-bubble annotation, streaming fence,
 *     fence-only placeholder) and the wire still carries the annotation.
 *
 * Non-vacuity: each assertion reads an observable outcome (input values, bar
 * visibility), so deleting the auto-apply trigger, the undo frame capture, or
 * a strip turns exactly its checks red.
 *
 * Usage: node scripts/probe-form-assist.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-form-assist-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { NotifyBridge } from './src/renderer/src/utils/notify'
import { RoutineForm } from './src/renderer/src/components/routine/RoutineForm'
import { FormAssistColumn } from './src/renderer/src/components/form-assist/FormAssistColumn'
import { useFormAssistSession } from './src/renderer/src/components/form-assist/useFormAssistSession'
import { buildFormAssistSystemPrompt } from './src/renderer/src/components/form-assist/form-assist'
import { ROUTINE_ASSIST_SPEC } from './src/renderer/src/components/routine/routine-assist'
import { applyAssistantPatch, EMPTY_DRAFT } from './src/renderer/src/components/routine/routine-form-model'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

// ── Hosted-session stubs at the electronAPI seam ──
const listeners = new Set()
const state = { convId: 'routine_assist_A', sent: [], draft: EMPTY_DRAFT }
// Conversation B's STORED history — served through hydrateConversation, the
// same channel production restores from (events only ever carry NEW turns).
const B_STORED = [
  {
    id: 'b1',
    role: 'assistant',
    content: 'B 的旧提案。',
    // \\n so the HARNESS string (this file is a template literal) carries the
    // escape, not a raw newline; \x60 becomes a real backtick — legal inside
    // the harness's single-quoted string.
    contentBlocks: [{ type: 'text', text: 'B 的旧提案。\\n\x60\x60\x60form-patch\\n{"name":"B的旧草稿"}\\n\x60\x60\x60' }],
    createdAt: new Date().toISOString(),
  },
]
const FIXTURES = {
  getSettings: () => ({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '' }),
  onAgentSessionEvent: (cb) => {
    listeners.add(cb)
    window.__subGen = (window.__subGen ?? 0) + 1 // re-subscribe generation (conv-switch waits on it)
    return () => listeners.delete(cb)
  },
  agentSessionSnapshot: () => Promise.resolve(null),
  hydrateConversation: (id) => Promise.resolve(id === 'routine_assist_B' ? { messages: B_STORED } : { messages: [] }),
  agentSessionCreate: () => Promise.resolve({ sessionId: '', agentId: '' }),
  agentSessionAsk: (id, content) => { state.sent.push({ id, content }); return Promise.resolve() },
  agentSessionEngineCall: () => Promise.resolve(),
  agentSessionCancel: () => Promise.resolve(),
  agentSessionRefreshOptions: () => Promise.resolve(),
  setConversationApprovalMode: () => Promise.resolve(),
  saveConversation: () => Promise.resolve(),
  // InputArea's mount-time catalog loads .then(setExperts) straight into state —
  // a bare undefined would crash its filter on the next render.
  expertList: () => Promise.resolve([]),
  knowledgeListBases: () => Promise.resolve([]),
}
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (FIXTURES[key] ?? (() => Promise.resolve())),
})
// The probe emits exactly what session-manager broadcasts: { sessionId, data }.
window.__emit = (events, convId) => {
  for (const data of events) listeners.forEach((cb) => cb({ sessionId: convId ?? state.convId, data }))
}
window.__state = state

function ProbeHost() {
  const [convId, setConvId] = useState('routine_assist_A')
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const draftRef = useRef(draft)
  useEffect(() => { draftRef.current = draft; state.draft = draft }, [draft])
  useEffect(() => { window.__setConvId = setConvId }, [])
  useEffect(() => {
    // Section-scoped rewind for the probe only: the placeholder message STAYS
    // in the transcript, its patch is simply wound out of the form so the
    // next section starts from the empty state.
    window.__reset = () => { undoRef.current = []; setDraft(EMPTY_DRAFT) }
  }, [])
  // The page's real shape: every apply captures the PRE-patch draft; 撤销
  // pops it back and clears the bar.
  const undoRef = useRef([])
  const assist = useFormAssistSession({
    convId,
    title: 'probe',
    spec: ROUTINE_ASSIST_SPEC,
    systemPrompt: buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC),
    onPatch: (patch) => {
      undoRef.current.push(draftRef.current)
      setDraft(applyAssistantPatch(patch, draftRef.current))
    },
  })
  const undo = () => {
    const frame = undoRef.current[undoRef.current.length - 1]
    if (!frame) return
    undoRef.current = undoRef.current.slice(0, -1)
    setDraft(frame)
    assist.clearAppliedPatch()
  }
  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
      <div data-panel="form" style={{ width: 640, height: 880, overflowY: 'auto', background: '#fafafa', border: '1px solid #eee' }}>
        <div style={{ padding: 12, background: '#fff' }}>
          <RoutineForm
            draft={draft}
            onChange={setDraft}
            appliedAssistantPatch={assist.appliedPatch}
            onUndoAssistantPatch={undo}
          />
        </div>
      </div>
      <div data-panel="chat" style={{ width: 480, height: 880, background: '#fff', border: '1px solid #eee' }}>
        <FormAssistColumn
          session={assist}
          title="任务助手"
          placeholder="描述你想自动化的工作…"
          onSendMessage={(text) => assist.send(text, { name: draftRef.current.name })}
        />
      </div>
    </div>
  )
}

function Harness() {
  return (
    <ConfigProvider theme={{ token: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" } }}>
      <AntdApp>
        <NotifyBridge />
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <ProbeHost />
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('app')).render(<Harness />)
`

const OUT = join(tmpdir(), `pm-form-assist-${process.pid}.js`)
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => {
  console.error('[pageerror]', e.message)
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'))
})
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => document.querySelector('[data-panel="chat"] textarea'), null, { timeout: 15000 })

const chatText = () => page.evaluate(() => document.querySelector('[data-panel="chat"]').textContent)
const emit = (events, convId) => page.evaluate(([e, c]) => window.__emit(e, c), [events, convId])
const formState = () => page.evaluate(() => window.__state.draft)
const iso = () => new Date().toISOString()
const userMsg = (text, id) => ({ id, role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: iso() })
const assistantMsg = (text, id) => ({ id, role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: iso() })
const bar = page.locator('[data-panel="form"] [role="status"]')
const undoButton = bar.getByRole('button', { name: /撤\s*销/ })

// ── 1. user 气泡：[当前表单] JSON 只走 wire，不进渲染 ──
await emit([
  { type: 'messages', messages: [userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":"","prompt":""}', 'u1')] },
  { type: 'status', status: 'completed' },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('帮我做个巡检任务'), null, { timeout: 10000 })
const t1 = await chatText()
check('user 气泡渲染了消息文本', t1.includes('帮我做个巡检任务'))
check('user 气泡不渲染 [当前表单] 注记', !t1.includes('[当前表单]'), t1.includes('[当前表单]') ? 'leaked' : 'clean')
check('user 气泡不渲染注记里的 JSON', !t1.includes('"prompt"'))

// ── 2. 流式：不完整的围栏被截断，JSON 不裸奔 ──
await emit([
  { type: 'status', status: 'streaming' },
  { type: 'streaming_blocks', blocks: [{ type: 'text', text: '好的，我来填\n```form-patch\n{"name":"每日巡' }] },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('好的，我来填'), null, { timeout: 10000 })
const t2 = await chatText()
check('流式正文渲染', t2.includes('好的，我来填'))
check('流式不渲染围栏起始标记', !t2.includes('form-patch'))
check('流式不渲染半截 JSON', !t2.includes('"name":"每日巡'))

// ── 3. 纯围栏回复 → 占位文案（流式中途替换成完整回复）──
await emit([
  { type: 'streaming_blocks', blocks: [] },
  { type: 'status', status: 'completed' },
  { type: 'messages', messages: [userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'), assistantMsg('```form-patch\n{"name":"占位测试"}\n```', 'a0')] },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('（已生成表单内容'), null, { timeout: 10000 })
const t3 = await chatText()
check('纯围栏回复渲染占位文案', t3.includes('（已生成表单内容'))
check('占位路径不泄漏 JSON 原文', !t3.includes('{"name":"占位测试"}'))
// 2026-09-20 裁定的另一面：占位回复里的补丁也是结论，同样直接填入表单。
check('纯围栏回复的补丁同样直接填入表单', await page.evaluate(() => window.__state.draft.name === '占位测试'))
await page.evaluate(() => window.__reset())
await page.waitForFunction(() => (window.__state.draft.name === ''), null, { timeout: 10000 })

// ── 4. 自动填入：回复一落地，表单就有值；撤销条就位；没有评审卡 ──
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('帮你设计了任务：每天巡检一次。\n```form-patch\n{"name":"每日巡检","prompt":"检查 {{repo}} 的漏洞","cron":"30 9 * * *"}\n```', 'a1'),
    ],
  },
  { type: 'status', status: 'completed' },
])
await page.waitForFunction(() => (window.__state.draft.name === '每日巡检'), null, { timeout: 10000 })
const d4 = await formState()
check('补丁未经确认直接写进表单', d4.name === '每日巡检' && d4.prompt === '检查 {{repo}} 的漏洞', JSON.stringify(d4))
check('cron 走友好定时字段（scheduleEnabled + 09:30）', d4.scheduleEnabled === true && d4.sched?.time === '09:30')
check('撤销条出现并点名词补丁', (await bar.count()) === 1 && (await bar.textContent()).includes('助手已将结论填入表单') && (await bar.textContent()).includes('「每日巡检」'))
check('草稿模式不复活：表单列没有勾选框', (await page.locator('[data-panel="form"] .ant-checkbox-input').count()) === 0)
const t4 = await chatText()
check('气泡只留说明文字，不露围栏与 JSON', t4.includes('帮你设计了任务') && !t4.includes('form-patch') && !t4.includes('"name":"每日巡检"'))
await page.screenshot({ path: join(SHOTS, 'form-assist-auto-apply.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })

// ── 5. 撤销：一键回到填入前的表单 ──
await undoButton.click()
await page.waitForFunction(() => (window.__state.draft.name === ''), null, { timeout: 10000 })
const d5 = await formState()
check('撤销后表单恢复原值', d5.name === '' && d5.prompt === '' && d5.scheduleEnabled === false, JSON.stringify(d5))
check('撤销后撤销条消失', (await bar.count()) === 0)

// ── 6. 同一条消息的后续变异不重发 ──
await emit([{ type: 'message_stats', updates: [{ messageId: 'a1', processingMs: 456 }] }])
await page.waitForTimeout(300)
const d6 = await formState()
check('message_stats 触及原消息 → 不重新填入', d6.name === '' && d6.name !== '每日巡检')
check('不重新出现撤销条', (await bar.count()) === 0)
// Full-list re-delivery of the identical content must also be inert.
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('帮你设计了任务：每天巡检一次。\n```form-patch\n{"name":"每日巡检","prompt":"检查 {{repo}} 的漏洞","cron":"30 9 * * *"}\n```', 'a1'),
    ],
  },
])
await page.waitForTimeout(300)
check('同内容整表重发 → 仍不重新填入', (await formState()).name === '')

// ── 7. 新回合的新补丁照常填入；撤销回到「上一次填入后」的中间态 ──
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('帮你设计了任务：每天巡检一次。\n```form-patch\n{"name":"每日巡检","prompt":"检查 {{repo}} 的漏洞","cron":"30 9 * * *"}\n```', 'a1'),
      userMsg('改成每周的吧', 'u2'),
      assistantMsg('改好了。\n```form-patch\n{"name":"每周备份"}\n```', 'a2'),
    ],
  },
])
await page.waitForFunction(() => (window.__state.draft.name === '每周备份'), null, { timeout: 10000 })
check('新回复的新补丁再次自动填入', (await formState()).name === '每周备份')
check('撤销条更新为最新补丁', (await bar.textContent()).includes('「每周备份」'))
// messages_append: one more turn appended to the same conversation.
await emit([
  { type: 'messages_append', fromIndex: 4, items: [assistantMsg('再改一版。\n```form-patch\n{"name":"第三版","prompt":"v3"}\n```', 'a3')] },
])
await page.waitForFunction(() => (window.__state.draft.name === '第三版'), null, { timeout: 10000 })
check('messages_append 的新补丁也自动填入', (await formState()).prompt === 'v3')
await undoButton.click()
await page.waitForFunction(() => (window.__state.draft.name === '每周备份'), null, { timeout: 10000 })
check('撤销回到本次填入前的中间态（每周备份）', (await formState()).name === '每周备份' && (await formState()).prompt === '')
check('撤销后撤销条消失', (await bar.count()) === 0)

// ── 8. 填入后的手动编辑属于「当前状态」，随下一次撤销一起回退 ──
await page.fill('[data-panel="form"] input', '手动改过')
await emit([
  { type: 'messages_append', fromIndex: 5, items: [assistantMsg('第四版。\n```form-patch\n{"name":"第四版"}\n```', 'a4')] },
])
await page.waitForFunction(() => (window.__state.draft.name === '第四版'), null, { timeout: 10000 })
await undoButton.click()
await page.waitForFunction(() => (window.__state.draft.name === '手动改过'), null, { timeout: 10000 })
check('撤销连手动编辑一起恢复（帧在填入时捕获）', (await formState()).name === '手动改过')

// ── 9. 纯文字回复让撤销条退役，表单不动 ──
await emit([
  { type: 'messages_append', fromIndex: 6, items: [assistantMsg('还需要你确认巡检哪些仓库？', 'a5')] },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('还需要你确认巡检哪些仓库'), null, { timeout: 10000 })
await page.waitForTimeout(200)
check('纯文字回复后撤销条退役', (await bar.count()) === 0)
check('纯文字回复不改表单', (await formState()).name === '手动改过')

// ── 10. hydration 守卫：切到一条带历史围栏的会话，不得重放进表单 ──
const genBefore = await page.evaluate(() => window.__subGen)
await page.evaluate(() => window.__setConvId('routine_assist_B'))
// The hook re-subscribes asynchronously; emitting into the stale closure would
// be silently filtered by its captured convId. Wait for the new generation.
await page.waitForFunction((g) => window.__subGen > g, genBefore, { timeout: 10000 })
// B's history arrives through hydrateConversation (the production restore
// channel); its OLD fence reply must render in the transcript but never land
// in the form.
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('B 的旧提案'), null, { timeout: 10000 })
await page.waitForTimeout(300)
check('恢复的历史不重放进表单', (await formState()).name === '手动改过')
check('恢复的历史不出现撤销条', (await bar.count()) === 0)
// But a genuinely NEW reply in the new conversation applies as usual.
await emit(
  [{ type: 'messages_append', fromIndex: 1, items: [assistantMsg('B 的新填。\n```form-patch\n{"name":"B的新填"}\n```', 'b2')] }],
  'routine_assist_B',
)
await page.waitForFunction(() => (window.__state.draft.name === 'B的新填'), null, { timeout: 10000 })
check('新会话里的新回复照常填入', (await formState()).name === 'B的新填')
check('新会话的撤销条就位', (await bar.count()) === 1 && (await bar.textContent()).includes('「B的新填」'))
await page.screenshot({ path: join(SHOTS, 'form-assist-conv-switch.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })

// ── 11. wire 留痕：发送仍带 [当前表单]（渲染剥离 ≠ 协议剥离）──
await page.fill('[data-panel="chat"] textarea', '再帮我改一版')
await page.keyboard.press('Enter')
await page.waitForFunction(() => window.__state.sent.length > 0, null, { timeout: 10000 })
const lastSend = await page.evaluate(() => window.__state.sent[window.__state.sent.length - 1])
check('发送的 wire 内容仍携带 [当前表单] 注记', lastSend.content.includes('[当前表单]'))

// ── 收尾 ──
await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
