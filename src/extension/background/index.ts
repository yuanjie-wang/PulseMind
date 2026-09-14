/** Extension service worker (PLAN-browser-extension M0.5 skeleton).
 *
 * M0 scope: discover + pair with the desktop agent service, hold the
 * WebSocket, answer `hello`, expose connection state to the options page and
 * keep the worker alive via chrome.alarms. Session/chat routing and the page
 * tools arrive in M1/M2 — until then tool.call is answered with an explicit
 * "not yet implemented" so the service never waits out its timeout. */

import { loadConfig, saveConfig, type ExtensionConfig } from './config'
import { discoverService } from './discovery'
import { WsClient } from './ws-client'

const CLIENT_ID = 'pulsemind-extension'
const KEEPALIVE_ALARM = 'pulsemind-keepalive'
const STATE_MESSAGE_TYPE = 'pulsemind/get-state'
const RECONNECT_MESSAGE_TYPE = 'pulsemind/reconnect'

const state: { client: WsClient | null; clientKey: string; discovery: { wsUrl: string; port: number } | null } = {
  client: null,
  clientKey: '',
  discovery: null,
}

function currentState(): Record<string, unknown> {
  return {
    connected: state.client?.connected ?? false,
    state: state.client?.state ?? 'closed',
    serviceUrl: state.discovery?.wsUrl ?? null,
    port: state.discovery?.port ?? null,
  }
}

function broadcastState(): void {
  chrome.runtime.sendMessage({ type: STATE_MESSAGE_TYPE, payload: currentState() }).catch(() => {
    // No listener (options closed) — fine.
  })
}

async function ensureClient(forceRediscover = false): Promise<void> {
  if (forceRediscover) {
    state.client?.close()
    state.client = null
    state.clientKey = ''
    state.discovery = null
  }
  if (state.client && state.client.connected) return

  const cfg: ExtensionConfig = await loadConfig()
  if (!state.discovery || forceRediscover) {
    const found = await discoverService(cfg)
    if (!found) {
      state.client = null
      state.clientKey = ''
      broadcastState()
      return
    }
    state.discovery = { wsUrl: found.wsUrl, port: found.port }
    // Persist the discovered endpoint/token so the options page shows what is
    // actually in use (manual overrides in cfg win over discovery).
    if (!cfg.serviceUrl || !cfg.token) await saveConfig({ serviceUrl: found.wsUrl, token: found.token })
  }

  const key = `${state.discovery.wsUrl}|${cfg.token ?? ''}`
  if (state.client && state.clientKey === key) return

  state.client?.close()
  const client = new WsClient(
    {
      wsUrl: state.discovery.wsUrl,
      token: cfg.token ?? '',
      clientId: CLIENT_ID,
      clientVersion: chrome.runtime.getManifest().version,
      protocolVersion: 1,
    },
    {
      onStateChange: () => broadcastState(),
      onEvent: (params) => {
        // M1 routes these to the page panel / side panel. M0: log only.
        console.log('[PulseMind] agent.event', params)
      },
      onNotification: (method, params) => {
        if (method === 'tool.call') {
          // No content script yet (M1/M2) — fail fast instead of stalling the
          // engine until the per-tool timeout.
          state.client?.notify('tool.result', {
            callId: params.callId,
            ok: false,
            error: '页面工具尚未接入（M1/M2 提供 content script）',
          })
          return
        }
        console.log('[PulseMind] notification', method, params)
      },
    },
  )
  state.client = client
  state.clientKey = key
  void client.connect().catch(() => { /* state change already broadcast */ })
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
  if (state.client && !state.client.connected && state.client.state === 'closed') {
    void state.client.connect().catch(() => {})
  } else {
    void ensureClient()
  }
})

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === STATE_MESSAGE_TYPE) {
    sendResponse(currentState())
    return false
  }
  if (msg?.type === RECONNECT_MESSAGE_TYPE) {
    void ensureClient(true).then(() => sendResponse(currentState()))
    return true // async response
  }
  return false
})

// SW cold start (no onInstalled/onStartup fired): try once.
void ensureClient()
