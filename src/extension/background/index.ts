/** Extension service worker (PLAN-browser-extension M0.5 skeleton + M1 panel +
 *  M2 page tools).
 *
 * M0: discover + pair with the desktop agent service, hold the WebSocket, answer
 * `hello`, expose connection state to the options page, stay alive via alarms.
 * M1: route the in-page panel — session lifecycle, asks, and the event stream
 * that fills the panel transcript. M2: answer `tool.call` by driving the tab's
 * content script (see tool-router.ts). */

import { CloseCodes, Methods, PROTOCOL_VERSION } from '../../shared/agent-protocol/methods'
import type { AgentEventParams, ToolCallParams } from '../../shared/agent-protocol'
import { isPanelRequest, OPEN_OPTIONS_MESSAGE_TYPE, type ConnectionState } from '../bridge'
import { resetCspVerdict } from './cdp'
import { loadConfig, saveConfig, type ExtensionConfig } from './config'
import { discoverService } from './discovery'
import { PanelBridge } from './panel-bridge'
import { routeToolCall } from './tool-router'
import { WsClient } from './ws-client'

const CLIENT_ID = 'pulsemind-extension'
const KEEPALIVE_ALARM = 'pulsemind-keepalive'
const STATE_MESSAGE_TYPE = 'pulsemind/get-state'
const RECONNECT_MESSAGE_TYPE = 'pulsemind/reconnect'

const state: {
  client: WsClient | null
  clientKey: string
  discovery: { wsUrl: string; port: number } | null
  reason: string
} = { client: null, clientKey: '', discovery: null, reason: '正在启动' }

/** One pass of ensureClient at a time: the SW receives overlapping wake-ups
 *  (module cold start + onInstalled + alarm + options reconnect) and two
 *  clients with the same clientId would kick each other in a loop. */
let ensuring: Promise<void> | null = null
let ensureQueued = false
/** Guards against a re-pair loop when the service keeps rejecting the token. */
let tokenResyncDone = false

/** Panel routing lives in its own module; this file only assembles it. */
const bridge = new PanelBridge({
  getClient: () => state.client,
  getConnection: () => connectionState(),
})

function connectionState(): ConnectionState {
  return {
    state: state.client?.state ?? 'closed',
    connected: state.client?.connected ?? false,
    reason: state.client?.lastError || state.reason || undefined,
    serviceUrl: state.discovery?.wsUrl ?? undefined,
  }
}

function currentState(): Record<string, unknown> {
  const conn = connectionState()
  return {
    connected: conn.connected,
    state: conn.state,
    serviceUrl: state.discovery?.wsUrl ?? null,
    port: state.discovery?.port ?? null,
    reason: conn.reason ?? '',
  }
}

function broadcastState(): void {
  chrome.runtime.sendMessage({ type: STATE_MESSAGE_TYPE, payload: currentState() }).catch(() => {
    // No listener (options closed) — fine.
  })
}

/** Serialized entry point; `forceRediscover` requests are coalesced into one
 *  extra pass after the in-flight one instead of racing it. */
async function ensureClient(forceRediscover = false): Promise<void> {
  if (ensuring) {
    if (forceRediscover) ensureQueued = true
    return ensuring
  }
  ensuring = runEnsureClient(forceRediscover)
  try {
    await ensuring
  } finally {
    ensuring = null
  }
  if (ensureQueued) {
    ensureQueued = false
    await ensureClient(true)
  }
}

async function runEnsureClient(forceRediscover: boolean): Promise<void> {
  if (forceRediscover) {
    state.client?.close()
    state.client = null
    state.clientKey = ''
    state.discovery = null
    state.reason = '正在重新发现服务'
  }
  if (state.client?.connected) return

  const cfg: ExtensionConfig = await loadConfig()
  if (!state.discovery) {
    const found = await discoverService(cfg)
    if (!found) {
      state.client?.close()
      state.client = null
      state.clientKey = ''
      state.reason = cfg.serviceUrl
        ? `未连接到手动指定的服务（${cfg.serviceUrl} 无响应）`
        : '未发现桌面端服务（端口 8765–8779 无响应）'
      broadcastState()
      return
    }
    state.discovery = { wsUrl: found.wsUrl, port: found.port }
    // Persist ONLY what was missing, so the options page shows the endpoint in
    // use without overwriting the user's manual literals: a manual serviceUrl
    // (or token) is what discovery just used — saving the discovered form over
    // it would silently rewrite e.g. ws://localhost:8765 into ws://127.0.0.1:8765.
    const patch: ExtensionConfig = {}
    if (!cfg.serviceUrl) patch.serviceUrl = found.wsUrl
    if (!cfg.token) patch.token = found.token
    if (patch.serviceUrl || patch.token) await saveConfig(patch)
  }

  const token = cfg.token ?? (await loadConfig()).token ?? ''
  const key = `${state.discovery.wsUrl}|${token}`
  // A fatal client (hello protocol mismatch) must not block this pass: the
  // keepalive alarm comes through here every 30s and is the ONE recovery path
  // once reconnects stopped — rebuild it so a desktop that upgrades re-heals.
  if (state.client && state.clientKey === key && !state.client.fatal) return

  state.client?.close()
  const client = new WsClient(
    {
      wsUrl: state.discovery.wsUrl,
      token,
      clientId: CLIENT_ID,
      clientVersion: chrome.runtime.getManifest().version,
      // 单一来源（full_20261011 M12-P1-3/X9）：字面量曾与共享常量各走各的——
      // 抬一次 PROTOCOL_VERSION，扩展面板就因握手被拒且 fatal 而致命断连。
      protocolVersion: PROTOCOL_VERSION,
    },
    {
      onStateChange: () => handleStateChange(),
      onEvent: (params: AgentEventParams) => bridge.onAgentEvent(params.sessionId, params.data),
      onNotification: (method, params) => handleNotification(method, params),
    },
  )
  state.client = client
  state.clientKey = key
  state.reason = '正在连接'
  console.log(`[PulseMind] connecting to ${state.discovery.wsUrl}`)
  await client.connect().catch((err: Error) => {
    state.reason = err.message
    console.warn('[PulseMind] connect failed:', err.message)
  })
}

function handleStateChange(): void {
  const client = state.client
  if (client?.connected) {
    tokenResyncDone = false
    state.reason = ''
    console.log(`[PulseMind] connected to ${state.discovery?.wsUrl}`)
  } else if (client?.lastCloseCode === CloseCodes.unauthorized && !tokenResyncDone) {
    // Stale token (service restarted with a fresh one): drop it and re-pair.
    tokenResyncDone = true
    console.warn('[PulseMind] token rejected (4401) — clearing it and re-pairing')
    void saveConfig({ token: '' }).then(() => ensureClient(true))
  } else if (client?.lastError) {
    state.reason = client.lastError
    console.warn('[PulseMind]', client.lastError)
  }
  broadcastState()
  // Panels show the connection banner themselves, so they need the same news.
  bridge.onConnectionChange(connectionState())
}

function handleNotification(method: string, params: Record<string, unknown>): void {
  if (method === Methods.toolCall) {
    // The engine is parked on this call; answering it (or failing it fast) is
    // what keeps the loop moving. routeToolCall never throws and always replies.
    void routeToolCall(params as unknown as ToolCallParams, {
      sendResult: (result) => state.client?.notify(Methods.toolResult, result),
    }).catch((err: Error) => {
      state.client?.notify(Methods.toolResult, {
        callId: (params as { callId?: unknown }).callId,
        ok: false,
        error: `页面工具分发失败：${err.message}`,
      })
    })
    return
  }
  console.log('[PulseMind] notification', method, params)
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  void ensureClient(true)
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  void ensureClient()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  // ensureClient owns reconnect decisions (a live client self-reconnects with
  // backoff; a closed one must not be resurrected here).
  void ensureClient()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  resetCspVerdict(tabId)
  void bridge.onTabClosed(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A navigation replaces the document, so a recorded "this page forbids eval"
  // verdict no longer describes it.
  if (info.status === 'loading') resetCspVerdict(tabId)
})

chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  if (msg?.type === STATE_MESSAGE_TYPE) {
    sendResponse(currentState())
    return false
  }
  if (msg?.type === OPEN_OPTIONS_MESSAGE_TYPE) {
    // The panel's 打开设置 banner button: openOptionsPage exists only in
    // extension contexts (a content script's chrome.runtime lacks it), so the
    // content script forwards here. The sender DOES await a reply: a branch
    // that returns without sendResponse rejects its promise-shaped sendMessage
    // ("The message port closed before a response was received") — a
    // false-alarm warn on every SUCCESSFUL open (review_20261010 低5). The
    // success path answers {ok:true}; genuine failures answer {ok:false}.
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => {
        console.warn('[PulseMind] open options failed:', err instanceof Error ? err.message : err)
        sendResponse({ ok: false })
      })
    return true // async response — the receipt above needs the port kept open
  }
  if (msg?.type === RECONNECT_MESSAGE_TYPE) {
    void ensureClient(true).then(() => sendResponse(currentState()))
    return true // async response
  }
  if (isPanelRequest(msg)) {
    void bridge.handleRequest(msg, sender.tab?.id ?? null).then(sendResponse)
    return true // async response
  }
  return false
})

// SW cold start (no onInstalled/onStartup fired): try once.
void ensureClient()
