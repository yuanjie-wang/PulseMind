// ── 扩展面板状态面补齐(2026-10-31,PLAN-extension-panel-state-surface)──
// mirror 早已折叠 plan / file_changes / lastCompaction 三态,重试计数也早已
// 走事件流——缺的是渲染面与冷附着快照。本文件钉两层:真代码驱动的行为测试
// (seedSessionState 的可选字段)与源码扫描的 wiring 钉(每条写明非空条件)。
// 真实浏览器的端到端验收在 scripts/probe-panel-state.mjs(与
// probe-panel-render.mjs 同一 recipe:先 build:extension,无头 Chromium
// channel:'chromium' 起 MV3 SW)。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshSessionState, mirroredStatus, seedSessionState } from '../src/shared/agent-session/mirror'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const METHODS = read('src', 'shared', 'agent-protocol', 'methods.ts')
const PAYLOADS = read('src', 'shared', 'agent-protocol', 'payloads.ts')
const WS_SERVER = read('src', 'main', 'agent', 'ws-server.ts')
const SERVICE_SESSIONS = read('src', 'main', 'agent', 'service-sessions.ts')
const SESSION_MANAGER = read('src', 'main', 'agent', 'session-manager.ts')
const CONVERSATION_DB = read('src', 'main', 'storage', 'conversation.db.ts')
const ENGINE = read('src', 'renderer', 'src', 'agent', 'AgentEngine.ts')
const PANEL_BRIDGE = read('src', 'extension', 'background', 'panel-bridge.ts')
const BRIDGE = read('src', 'extension', 'bridge.ts')
const USE_PANEL = read('src', 'extension', 'ui', 'usePanel.ts')
const APP = read('src', 'extension', 'ui', 'App.tsx')
const STATE_STRIP = read('src', 'extension', 'ui', 'StateStrip.tsx')
const SESSIONS_MENU = read('src', 'extension', 'ui', 'SessionsMenu.tsx')
const TRANSCRIPT = read('src', 'extension', 'ui', 'Transcript.tsx')
const MESSAGE_BLOCKS = read('src', 'extension', 'ui', 'MessageBlocks.tsx')
const MESSAGE_GROUP = read('src', 'renderer', 'src', 'components', 'chat', 'MessageGroup.tsx')
const HTML_CARD = read('src', 'extension', 'ui', 'HtmlArtifactCard.tsx')
const ICONS = read('src', 'extension', 'ui', 'icons.tsx')

describe('agent.snapshot: the re-attach still-life over the wire', () => {
  it('the protocol declares the method and its result shape', () => {
    expect(METHODS).toContain("agentSnapshot: 'agent.snapshot'")
    expect(PAYLOADS).toMatch(/export interface AgentSnapshotResult \{[\s\S]*?lastCompaction: CompactionEvent \| null/)
  })

  it('ws-server routes agentSnapshot to sessions.snapshot and answers sessionNotFound on a miss', () => {
    // Non-vacuous: deleting the case fails the routing scan; routing to
    // history() instead fails the compound match.
    expect(WS_SERVER).toContain('case Methods.agentSnapshot:')
    expect(WS_SERVER).toMatch(/case Methods\.agentSnapshot:[\s\S]{0,400}sessions\.snapshot\(/)
  })

  it('the sessions slice declares snapshot() and session-manager carries lastCompaction', () => {
    expect(SERVICE_SESSIONS).toMatch(/snapshot\(sessionId: string\): Promise<AgentSnapshotResult \| null>/)
    expect(SESSION_MANAGER).toMatch(/lastCompaction: entry\.engine\.lastCompaction/)
  })

  it('the engine retains the compaction event through one emission funnel', () => {
    // Non-vacuous: a call site that fires the callback directly (bypassing
    // emitCompaction) fails the absence scan; removing the retention fails
    // the funnel body match.
    expect(ENGINE).toContain('lastCompaction: CompactionEvent | null = null')
    expect(ENGINE).toMatch(/private emitCompaction\(event: CompactionEvent\): void \{[\s\S]*?this\.lastCompaction = event/)
    // The funnel is the ONLY consumer of callbacks.onCompaction (its own body).
    const direct = ENGINE.match(/this\.callbacks\.onCompaction\?\./g) ?? []
    expect(direct.length).toBe(1)
  })

  it('the cold attach calls agent.snapshot and falls back to history', () => {
    // Non-vacuous: deleting the request line fails the first scan; removing
    // the history fallback fails the second.
    expect(PANEL_BRIDGE).toContain('client.request(Methods.agentSnapshot, { sessionId })')
    expect(PANEL_BRIDGE).toMatch(/catch[\s\S]{0,200}client\.request\(Methods\.agentHistory, \{ sessionId \}\)/)
    expect(PANEL_BRIDGE).toContain('seedSessionState(state, snap)')
  })

  it('the panel snapshot widens with the still-life and retry carriers', () => {
    for (const field of ['attempt?', 'maxRetries?', 'delayMs?', 'plan?', 'fileChanges?', 'lastCompaction?']) {
      expect(BRIDGE).toContain(field)
    }
  })
})

describe('seedSessionState: the optional still-life fields', () => {
  it('seeds plan, ledger and compaction from an agent.snapshot answer', () => {
    const state = freshSessionState()
    seedSessionState(state, {
      messages: [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }] }],
      status: { status: 'idle' },
      streamingBlocks: [],
      plan: { objective: '目标', nodes: [{ id: 'n1', description: '步骤', status: 'pending', dependsOn: [] }], completed: false, version: 2 },
      fileChanges: [{ path: '/w/a.ts', kind: 'created' }],
      lastCompaction: { ts: 1, source: 'request', strategies: ['nano'], droppedMessages: 2, replayedUserMessages: 0, tokensBefore: 900, tokensAfter: 400 },
    })
    expect(state.messages).toHaveLength(1)
    expect(state.plan?.objective).toBe('目标')
    expect(state.fileChanges).toEqual([{ path: '/w/a.ts', kind: 'created' }])
    expect(state.lastCompaction?.strategies).toEqual(['nano'])
  })

  it('absent fields seed the honest empty (older-service snapshots)', () => {
    const state = freshSessionState()
    state.lastCompaction = { ts: 1, source: 'request', strategies: [], droppedMessages: 0, replayedUserMessages: 0, tokensBefore: 0, tokensAfter: 0 }
    seedSessionState(state, { messages: [], status: { status: 'idle' }, streamingBlocks: [], plan: null })
    expect(state.plan).toBeNull()
    expect(state.fileChanges).toEqual([])
    expect(state.lastCompaction).toBeNull()
  })

  it('mirroredStatus keeps the retry count rebuild discipline (pair or bare word)', () => {
    const withPair = mirroredStatus({ status: 'retrying', attempt: 2, maxRetries: 5, delayMs: 4000 })
    expect(withPair).toMatchObject({ attempt: 2, maxRetries: 5, delay: 4000 })
    const bare = mirroredStatus({ status: 'retrying' })
    expect('attempt' in bare).toBe(false)
  })
})

describe('the panel folds the still-life and filters events by ref', () => {
  it('usePanel.seed lands plan/fileChanges/lastCompaction and the retry pair', () => {
    // Non-vacuous: deleting any of the three landing lines fails its scan;
    // dropping the spread (so the count never reaches mirroredStatus) fails
    // the conditional scan.
    expect(USE_PANEL).toMatch(/if \(snapshot\.plan !== undefined\) next\.plan =/)
    expect(USE_PANEL).toMatch(/if \(snapshot\.fileChanges !== undefined\) next\.fileChanges =/)
    expect(USE_PANEL).toMatch(/if \(snapshot\.lastCompaction !== undefined\) next\.lastCompaction =/)
    expect(USE_PANEL).toMatch(/snapshot\.attempt !== undefined && snapshot\.maxRetries !== undefined[\s\S]{0,120}delayMs: snapshot\.delayMs/)
  })

  it('the panel/event filter reads the ref, not the state', () => {
    // The resume race: seed() and React's commit are not atomic, so the old
    // state would admit a just-orphaned session's in-flight event. Non-vacuous:
    // reverting to `sessionId &&` (state) fails both scans.
    expect(USE_PANEL).toContain('sessionIdRef.current = snapshot.sessionId')
    expect(USE_PANEL).toContain('if (sessionIdRef.current && msg.sessionId !== sessionIdRef.current) return')
  })
})

describe('the header: retry count and the sessions menu', () => {
  it('the retrying status renders the (n/max · s) label, not the bare word', () => {
    expect(APP).toContain('function RetryStatusLabel')
    expect(APP).toMatch(/status\.attempt[\s\S]{0,80}status\.maxRetries/)
  })

  it('the header mounts SessionsMenu with resume and delete wired', () => {
    // Non-vacuous: removing the mount fails the first scan; wiring only
    // resume (leaving delete dead again) fails the compound match.
    expect(APP).toMatch(/<SessionsMenu[\s\S]{0,200}onResume=\{\(id\) => void panel\.resumeSession\(id\)\}/)
    expect(APP).toMatch(/onDelete=\{\(id\) => void panel\.deleteSession\(id\)\}/)
  })

  it('the sessions menu has the inline delete confirm', () => {
    expect(SESSIONS_MENU).toContain('confirmId')
    expect(SESSIONS_MENU).toContain('onDelete(s.sessionId)')
  })

  it('the icons carry the history and external glyphs on the outlined canvas', () => {
    // Non-vacuous: a name missing from PATHS fails the first pair; missing
    // from the outlined viewBox map fails the second (the box would travel
    // wrong, 1024 vs 64-canvas — the ink-size lesson from the popout batch).
    expect(ICONS).toMatch(/history: \[/)
    expect(ICONS).toMatch(/external: \[/)
    expect(ICONS).toMatch(/history: '64 64 896 896', external: '64 64 896 896'/)
  })
})

describe('the state strip renders the three folded states', () => {
  it('App mounts the strip above the composer with all three props', () => {
    expect(APP).toMatch(/<StateStrip plan=\{session\.plan\} fileChanges=\{session\.fileChanges\} lastCompaction=\{session\.lastCompaction\}/)
  })

  it('the strip renders plan checklist, file ink and the compaction chip', () => {
    // Non-vacuous: removing a section fails its data-marker scan; removing
    // the currentNodeId pass fails the current-prop scan.
    expect(STATE_STRIP).toContain('data-state-plan=""')
    expect(STATE_STRIP).toContain('data-state-files=""')
    expect(STATE_STRIP).toContain('data-state-compaction=""')
    expect(STATE_STRIP).toMatch(/current=\{plan\.currentNodeId === node\.id\}/)
    // The ink literals are the desktop tokens resolved for light
    // (--pm-ws-created/--pm-ws-modified, palette.ts).
    expect(STATE_STRIP).toContain("const INK_CREATED = '#587c0c'")
    expect(STATE_STRIP).toContain("const INK_MODIFIED = '#895503'")
  })
})

describe('the html card opens in the browser; user images render', () => {
  it('the toolbar carries the open button via about:blank + document.write', () => {
    // Non-vacuous: removing the button fails the title scan; removing the
    // write path fails the compound match.
    expect(HTML_CARD).toContain('title="在浏览器打开"')
    expect(HTML_CARD).toMatch(/const onOpenInBrowser = useCallback[\s\S]{0,400}win\.document\.write\(buildCardDocument\(code\)\)/)
  })

  it('user tool_result blocks render their screenshots and clipped output', () => {
    // Non-vacuous: reverting hasDisplayable to the old four-type union fails
    // the user-arm scan; removing the <img> map fails the bubble scan.
    expect(TRANSCRIPT).toMatch(/b\.type === 'tool_result' && msg\.role === 'user'/)
    expect(TRANSCRIPT).toMatch(/data:image\/png;base64,\$\{img\.imageData\}/)
    expect(TRANSCRIPT).toContain('className="pm-user-image"')
  })

  it('the user-arm counts imageData ONLY — a text tool_result carrier is not a user bubble', () => {
    // 2026-11-02 user report（tool use 的结果那块展示有问题）：引擎每轮把工具结果
    // 作为一条 user 消息追加（result-ingestion.ts），contentBlocks 全是带 content
    // 的 tool_result。11-01 的 user-arm 写成 `imageData || content`，于是每轮工具
    // 调用后都多出一个右侧用户气泡，里面是原始工具输出——卡里本就有【输出】。
    // 桌面 MessageGroup.hasDisplayableContent 只认 imageData，面板逐字同形。
    // Non-vacuous: restoring the `|| content` disjunct fails the negative scan;
    // dropping the imageData arm fails the positive one; the desktop side is
    // pinned too so the two gates cannot drift apart silently.
    expect(TRANSCRIPT).toMatch(/b\.type === 'tool_result' && msg\.role === 'user' && !!\(b as ToolResultBlock\)\.imageData\)/)
    expect(TRANSCRIPT).not.toMatch(/\.imageData \|\| \(b as ToolResultBlock\)\.content/)
    expect(MESSAGE_GROUP).toMatch(/\(b\.type === 'tool_result' && b\.imageData\)/)
    expect(MESSAGE_GROUP).not.toMatch(/tool_result' && \(b\.imageData \|\| b\.content\)/)
  })

  it('the tool card output box follows its tail while output streams (the desktop outputRef)', () => {
    // CommandCard scrolls its output container to the bottom on every
    // block.output change; the panel's 300px-capped .pm-cmd-out used to sit at
    // the top and hide the tail behind its scrollbar. Non-vacuous: removing the
    // effect fails the scan; dropping the ref off the element fails the second.
    expect(MESSAGE_BLOCKS).toMatch(/useEffect\(\(\) => \{\s*if \(outputRef\.current\) outputRef\.current\.scrollTop = outputRef\.current\.scrollHeight\s*\}, \[block\.output\]\)/)
    expect(MESSAGE_BLOCKS).toContain('<div className="pm-cmd-out" ref={outputRef}>')
  })
})

describe('历史会话 lists only conversations with messages (2026-11-02)', () => {
  // The DB layer is better-sqlite3 (Electron ABI — not loadable here), so the
  // predicate is pinned by scan; the behaviour it protects (the current empty
  // session's 授权 no longer read off the list) is driven for real in
  // tests/extension-panel-bridge.test.ts.
  it('listConversationsByOrigin keeps the origin key and adds the EXISTS(messages) predicate', () => {
    // Non-vacuous: dropping the EXISTS clause fails the first match; renaming
    // the origin predicate fails the second; the ORDER/LIMIT must survive.
    // The optional tab_key arm (2026-11-03) sits between them, so the pin
    // spells it out instead of letting `[\s\S]*?` swallow it.
    expect(CONVERSATION_DB).toMatch(
      /const scoped = tabKey \? 'AND c\.tab_key = \?' : ''[\s\S]*?WHERE c\.origin = \?\s*AND EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id\)\s*\$\{scoped\}\s*ORDER BY c\.updated_at DESC LIMIT \?/,
    )
  })

  it('agent.snapshot carries the stored 授权 and the bridge seeds its cache from it', () => {
    expect(PAYLOADS).toMatch(/export interface AgentSnapshotResult \{[\s\S]*?approvalMode\?: SandboxApprovalMode/)
    expect(SESSION_MANAGER).toMatch(/lastCompaction: entry\.engine\.lastCompaction,[\s\S]{0,700}approvalMode: this\.storedApprovalMode\(sessionId\),/)
    // Best-effort like the origin stamp: a column read failing (no DB in a
    // test harness, a torn-down store) must not cost the client the snapshot.
    expect(SESSION_MANAGER).toMatch(/private storedApprovalMode\(sessionId: string\): SandboxApprovalMode \| undefined \{\s*try \{ return getConversationApprovalMode\(sessionId\) \} catch \{ return undefined \}/)
    expect(PANEL_BRIDGE).toContain('private approvalModes = new Map<string, SandboxApprovalMode>()')
    expect(PANEL_BRIDGE).toMatch(/seedSessionState\(state, snap\)[\s\S]{0,400}if \(snap\.approvalMode\) this\.approvalModes\.set\(sessionId, snap\.approvalMode\)/)
    // Resolution order: list row → cache → tab carry (the row is the freshest
    // read of the column; the cache covers the session the list omits).
    expect(PANEL_BRIDGE).toMatch(/sessions\.find\(\(s\) => s\.sessionId === sessionId\)\?\.approvalMode \?\?\s*this\.approvalModes\.get\(sessionId\) \?\?\s*\(await getTabApprovalMode\(tabId\)\)/)
  })
})
