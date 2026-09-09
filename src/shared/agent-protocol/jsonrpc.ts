/** JSON-RPC 2.0 envelope types shared by every transport (WS for remote
 *  clients, IPC bridge for the Electron renderer). Envelope shape and error
 *  codes are kept wire-compatible with the Anywhere extension protocol so a
 *  single client implementation can talk to both services. */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** Application-level error codes (JSON-RPC reserved range below -32000). */
export const ErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authFailed: -32001,
  protocolVersionMismatch: -32002,
  sessionBusy: -32003,
  sessionNotFound: -32004,
  /** Authenticated but not allowed to call this method (chat-level token calling admin methods). */
  forbidden: -32005,
} as const

export function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

/** True when the message is a request that expects a response (has an id). */
export function isCall(msg: JsonRpcRequest): boolean {
  return msg.id !== undefined
}
