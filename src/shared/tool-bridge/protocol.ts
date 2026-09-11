// ── Tool bridge protocol (PLAN-0.4.0 M6.1) ──
// postMessage envelope shared by the in-page SDK and the renderer bridge host.
// The iframe is strictly sandboxed (opaque origin), so ALL host capabilities —
// storage, clipboard, network, files — flow through this channel.

export const BRIDGE_SOURCE_REQUEST = 'pulsemind-tool'
export const BRIDGE_SOURCE_RESPONSE = 'pulsemind-tool-host'

export const BRIDGE_METHODS = {
  // storage — always available (tool-scoped KV)
  storageGet: 'storage.get',
  storageSet: 'storage.set',
  storageRemove: 'storage.remove',
  storageKeys: 'storage.keys',
  // http (capability: net:http)
  httpRequest: 'http.request',
  // fs (capability: fs:read / fs:write — jailed to the tool directory)
  fsReadText: 'fs.readText',
  fsWriteText: 'fs.writeText',
  fsList: 'fs.list',
  fsExists: 'fs.exists',
  // system
  clipboardWrite: 'system.clipboard.write',
  clipboardRead: 'system.clipboard.read',
  notify: 'system.notify',
  openExternal: 'system.openExternal',
} as const

export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS]

export interface BridgeRequest {
  source: typeof BRIDGE_SOURCE_REQUEST
  /** Correlation id — echoed on the response. */
  id: string
  method: BridgeMethod
  params?: Record<string, unknown>
  /** Set by the host during injection; the SDK cannot forge trust — the host
   *  validates event.source and its own registered toolId, never this field. */
  toolId?: string
}

export interface BridgeResponse {
  source: typeof BRIDGE_SOURCE_RESPONSE
  id: string
  ok: boolean
  result?: unknown
  error?: { code: BridgeErrorCode; message: string }
}

export type BridgeErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_METHOD'
  | 'CAPABILITY_NOT_DECLARED'
  | 'PATH_OUTSIDE_TOOL_DIR'
  | 'TIMEOUT'
  | 'EXEC_FAILED'

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    typeof value === 'object' && value !== null &&
    (value as Record<string, unknown>).source === BRIDGE_SOURCE_REQUEST &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).method === 'string'
  )
}
