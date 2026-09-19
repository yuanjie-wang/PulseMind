/**
 * Real-browser render of the form-assist 提案 pipeline (PLAN-form-assist-proposals):
 * the routine editor's REAL form column + REAL assistant column wired through the
 * REAL useFormAssistSession, with the hosted session stubbed at the electronAPI
 * seam so the probe drives the same events the main process emits.
 *
 * It exists because the 2026-09-19 review found four P0 breaks here that no
 * source read could catch end to end: the [当前表单] JSON leaking into user
 * bubbles, streaming fence JSON painting raw, a proposal the user could not
 * review before it landed, and a dismiss that was silently unrecoverable.
 *
 * Non-vacuity: each assertion reads an observable outcome (bubble text, card
 * rows, applied draft state, chip visibility), so deleting any one of — the
 * user-annotation strip, the streaming-fence cut, the placeholder, the
 * key-filtered apply, or the convId reset — turns exactly its check red.
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
import { ROUTINE_ASSIST_SPEC, filterRoutinePatch } from './src/renderer/src/components/routine/routine-assist'
import { applyAssistantPatch, EMPTY_DRAFT } from './src/renderer/src/components/routine/routine-form-model'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

// ── Hosted-session stubs at the electronAPI seam ──
const listeners = new Set()
const state = { convId: 'routine_assist_A', sent: [], draft: EMPTY_DRAFT }
const FIXTURES = {
  getSettings: () => ({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '' }),
  onAgentSessionEvent: (cb) => {
    listeners.add(cb)
    window.__subGen = (window.__subGen ?? 0) + 1 // re-subscribe generation (D6's reset runs with it)
    return () => listeners.delete(cb)
  },
  agentSessionSnapshot: () => Promise.resolve(null),
  hydrateConversation: () => Promise.resolve({ messages: [] }),
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
  const assist = useFormAssistSession({
    convId,
    title: 'probe',
    spec: ROUTINE_ASSIST_SPEC,
    systemPrompt: buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC),
  })
  const apply = (keys) => {
    if (!assist.proposedPatch) return
    // The page's real apply shape: filter to the checked rows, then merge.
    const patch = filterRoutinePatch(assist.proposedPatch, keys)
    if (Object.keys(patch).length === 0) return
    setDraft(applyAssistantPatch(patch, draftRef.current))
    assist.clearProposedPatch()
  }
  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
      <div data-panel="form" style={{ width: 640, height: 880, overflowY: 'auto', background: '#fafafa', border: '1px solid #eee' }}>
        <div style={{ padding: 12, background: '#fff' }}>
          <RoutineForm
            draft={draft}
            onChange={setDraft}
            pendingAssistantDraft={assist.proposedPatch}
            restoreableAssistantDraft={assist.restoreablePatch}
            onApplyAssistantDraft={apply}
            onDismissAssistantDraft={assist.dismissProposal}
            onRestoreAssistantDraft={assist.restoreProposal}
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
const formText = () => page.evaluate(() => document.querySelector('[data-panel="form"]').textContent)
const emit = (events, convId) => page.evaluate(([e, c]) => window.__emit(e, c), [events, convId])
const iso = () => new Date().toISOString()
const userMsg = (text, id) => ({ id, role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: iso() })
const assistantMsg = (text, id) => ({ id, role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: iso() })

// ── 1. user 气泡：[当前表单] JSON 只走 wire，不进渲染（D1）──
await emit([
  { type: 'messages', messages: [userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":"","prompt":""}', 'u1')] },
  { type: 'status', status: 'completed' },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('帮我做个巡检任务'), null, { timeout: 10000 })
const t1 = await chatText()
check('user 气泡渲染了消息文本', t1.includes('帮我做个巡检任务'))
check('user 气泡不渲染 [当前表单] 注记', !t1.includes('[当前表单]'), t1.includes('[当前表单]') ? 'leaked' : 'clean')
check('user 气泡不渲染注记里的 JSON', !t1.includes('"prompt"'))

// ── 2. 流式：不完整的围栏被截断，JSON 不裸奔（D2）──
await emit([
  { type: 'status', status: 'streaming' },
  { type: 'streaming_blocks', blocks: [{ type: 'text', text: '好的，我来填\n```form-patch\n{"name":"每日巡' }] },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('好的，我来填'), null, { timeout: 10000 })
const t2 = await chatText()
check('流式正文渲染', t2.includes('好的，我来填'))
check('流式不渲染围栏起始标记', !t2.includes('form-patch'))
check('流式不渲染半截 JSON', !t2.includes('"name":"每日巡'))

// ── 3. 纯围栏回复 → 占位文案（D7）──
await emit([
  { type: 'streaming_blocks', blocks: [] },
  { type: 'status', status: 'completed' },
  { type: 'messages', messages: [userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'), assistantMsg('```form-patch\n{"name":"占位测试"}\n```', 'a0')] },
])
await page.waitForFunction(() => document.querySelector('[data-panel="chat"]').textContent.includes('（已生成表单草稿'), null, { timeout: 10000 })
const t3 = await chatText()
check('纯围栏回复渲染占位文案', t3.includes('（已生成表单草稿'))
check('占位路径不泄漏 JSON 原文', !t3.includes('{"name":"占位测试"}'))

// ── 4. 评审卡：字段级 diff，before 按当前表单实时计算（D3）──
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('这是说明。\n```form-patch\n{"name":"每日巡检","params":[{"key":"repo","label":"仓库","required":true}]}\n```', 'a1'),
    ],
  },
  { type: 'status', status: 'completed' },
])
await page.waitForSelector('[data-panel="form"] [role="status"]', { timeout: 10000 })
const card = page.locator('[data-panel="form"] [role="status"]')
const cardText = await card.textContent()
check('卡片头保留一行摘要', cardText.includes('对话生成了任务草稿'), cardText.slice(0, 60))
check('diff 行数 = 补丁携带的字段数（2）', (await card.locator('.ant-checkbox-input').count()) === 2)
check('任务名称行 before=（未填）after=每日巡检', cardText.includes('（未填）') && cardText.includes('每日巡检'))
check('参数行折叠为「N 个参数（keys）」摘要', cardText.includes('无参数') && cardText.includes('1 个参数（repo）'))
await page.screenshot({ path: join(SHOTS, 'form-assist-review-card.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })

// ── 5. 部分应用：只写勾选行（D4）──
await card.locator('.ant-checkbox-input').first().uncheck()
await card.getByRole('button', { name: /应\s*用/ }).click()
await page.waitForFunction(() => JSON.stringify(window.__state.draft), null, { timeout: 10000 })
const d5 = await page.evaluate(() => window.__state.draft)
check('未勾选的 name 保持现值', d5.name === '', d5.name)
check('勾选的 params 写入表单', d5.params?.[0]?.key === 'repo', JSON.stringify(d5.params))
check('应用后卡片消失', (await page.locator('[data-panel="form"] [role="status"]').count()) === 0)

// ── 6. 忽略 → 同内容再现 → 恢复 chip（D5）──
const REPLY2 = '改成每周的。\n```form-patch\n{"name":"每周备份"}\n```'
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('这是说明。\n```form-patch\n{"name":"每日巡检","params":[{"key":"repo","label":"仓库","required":true}]}\n```', 'a1'),
      assistantMsg(REPLY2, 'a2'),
    ],
  },
])
await page.waitForFunction(() => document.querySelector('[data-panel="form"]').textContent.includes('每周备份'), null, { timeout: 10000 })
await page
  .locator('[data-panel="form"] [role="status"]')
  .getByRole('button', { name: /忽\s*略/ })
  .click()
await page.waitForFunction(() => !document.querySelector('[data-panel="form"] [role="status"]'), null, { timeout: 10000 })
check('忽略后卡片隐藏', true)
// Same content arrives again (model re-emits the identical patch).
await emit([
  {
    type: 'messages',
    messages: [
      userMsg('帮我做个巡检任务\n\n[当前表单]\n{"name":""}', 'u1'),
      assistantMsg('这是说明。\n```form-patch\n{"name":"每日巡检","params":[{"key":"repo","label":"仓库","required":true}]}\n```', 'a1'),
      assistantMsg(REPLY2, 'a2'),
      assistantMsg('再给一次。\n```form-patch\n{"name":"每周备份"}\n```', 'a3'),
    ],
  },
])
await page.waitForFunction(() => document.querySelector('[data-panel="form"]').textContent.includes('已忽略同内容草稿'), null, { timeout: 10000 })
check('同内容提案再现 → 弱化恢复 chip（而非无声消失）', (await page.locator('[data-panel="form"] [role="status"]').count()) === 0)
await page.screenshot({ path: join(SHOTS, 'form-assist-restore-chip.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })
await page.locator('[data-panel="form"]').getByText('恢复').click()
await page.waitForSelector('[data-panel="form"] [role="status"]', { timeout: 10000 })
check('点击恢复 → 卡片重新出现', (await page.locator('[data-panel="form"] [role="status"]').textContent()).includes('每周备份'))

// ── 7. convId 切换重置 dismissed/恢复状态（D6）──
await page
  .locator('[data-panel="form"] [role="status"]')
  .getByRole('button', { name: /忽\s*略/ })
  .click()
await page.waitForFunction(() => !document.querySelector('[data-panel="form"] [role="status"]'), null, { timeout: 10000 })
const genBefore = await page.evaluate(() => window.__subGen)
await page.evaluate(() => window.__setConvId('routine_assist_B'))
// The hook re-subscribes asynchronously; emitting into the stale closure would
// be silently filtered by its captured convId. Wait for the new generation.
await page.waitForFunction((g) => window.__subGen > g, genBefore, { timeout: 10000 })
await emit(
  [
    { type: 'messages', messages: [assistantMsg('B 的提案。\n```form-patch\n{"name":"每周备份"}\n```', 'b1')] },
    { type: 'status', status: 'completed' },
  ],
  'routine_assist_B',
)
await page.waitForSelector('[data-panel="form"] [role="status"]', { timeout: 10000 })
const chipVisible = await page.evaluate(() => document.querySelector('[data-panel="form"]').textContent.includes('已忽略同内容草稿'))
check('convId 切换后 dismissed 状态重置：B 的同内容提案直接出卡、无恢复 chip', !chipVisible)

// ── 8. wire 留痕：发送仍带 [当前表单]（D1 的另一面：渲染剥离 ≠ 协议剥离）──
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
