/** Extension service worker (PLAN-browser-extension M0.5 skeleton + M1 panel +
 *  M2 page tools).
 *
 * M0: discover + pair with the desktop agent service, hold the WebSocket, answer
 * `hello`, expose connection state to the options page, stay alive via alarms.
 * M1: route the in-page panel — session lifecycle, asks, and the event stream
 * that fills the panel transcript. M2: answer `tool.call` by driving the tab's
 * content script (see tool-router.ts). */

import { CloseCodes, Methods } from '../../shared/agent-protocol/methods'
import type { AgentEventParams, ToolCallParams } from '../../shared/agent-protocol'
import { isPanelRequest, type ConnectionState } from '../bridge'
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
      state.reason = '未发现桌面端服务（端口 8765–8779 无响应）'
      broadcastState()
      return
    }
    state.discovery = { wsUrl: found.wsUrl, port: found.port }
    // Persist what we paired with so the options page shows the endpoint in use
    // (a manual override in cfg still wins on the next discovery pass).
    if (!cfg.serviceUrl || !cfg.token) await saveConfig({ serviceUrl: found.wsUrl, token: found.token })
  }

  const token = cfg.token ?? (await loadConfig()).token ?? ''
  const key = `${state.discovery.wsUrl}|${token}`
  if (state.client && state.clientKey === key) return

  state.client?.close()
  const client = new WsClient(
    {
      wsUrl: state.discovery.wsUrl,
      token,
      clientId: CLIENT_ID,
      clientVersion: chrome.runtime.getManifest().version,
      protocolVersion: 1,
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
