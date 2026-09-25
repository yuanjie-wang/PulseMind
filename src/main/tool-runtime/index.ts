// ── Tool runtime (PLAN-0.4.0 M6.4-M6.7) ──
// Main-process executor for tool bridge calls. Every call is gated by:
//   1. capability declaration in the tool's manifest (M6.5)
//   2. path jail (fs ops are jailed to the tool's own directory — D16)
//   3. audit (every call recorded — M6.7)

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clipboard, shell } from 'electron'
import { Notification } from 'electron'
import { toolStore } from '../storage/tool-store'
import { TOOLS_DIR } from '../storage'
import { auditStore } from '../storage/audit-store'
import { guardPath, buildBaselineDenyRoots } from '../../shared/sandbox/path-jail'
import { resolveRealTargetSync } from '../sandbox/real-path'
import { isPrivateHost } from '../utils/ssrf'
import { homedir, platform } from 'node:os'
import type { UserTool } from '../../shared/types/user-tool'

// Errors carry a `code` so the SDK can branch on it.
function bridgeError(code: string, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { code: string }).code = code
  return err
}

const REQUIRED_CAPABILITY: Record<string, string | null> = {
  'http.request': 'net:http',
  'fs.readText': 'fs:read',
  'fs.exists': 'fs:read',
  'fs.list': 'fs:read',
  'fs.writeText': 'fs:write',
  'system.clipboard.write': 'clipboard',
  'system.clipboard.read': 'clipboard',
  'system.notify': 'notify',
  'system.openExternal': 'open-external',
  'storage.get': null,
  'storage.set': null,
  'storage.remove': null,
  'storage.keys': null,
}

/** Literal hosts that must never be reachable from a generated tool even
 *  before DNS: the cloud-metadata name and mDNS suffixes may resolve through
 *  paths the shared private-IP classifier doesn't see (or not resolve at all). */
const LITERAL_BLOCKED_HOSTS = new Set(['metadata.google.internal', 'localhost', 'metadata.google', 'instance-data'])

/** SSRF gate for generated tools: literal metadata names + mDNS suffixes,
 *  then the shared private/reserved-range classifier (RFC1918, loopback,
 *  link-local, CGNAT, multicast — via literal IP or DNS). */
async function isBlockedHost(url: URL): Promise<boolean> {
  const host = url.hostname.toLowerCase()
  if (LITERAL_BLOCKED_HOSTS.has(host) || host.endsWith('.local')) return true
  return isPrivateHost(host)
}

// ── storage (KV per tool, storage.json) ──

function storagePath(toolId: string): string {
  return join(TOOLS_DIR, toolId, 'storage.json')
}

function readStorage(toolId: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(storagePath(toolId), 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const STORAGE_VALUE_LIMIT = 256 * 1024 // per value
const STORAGE_TOTAL_LIMIT = 1024 * 1024 // per tool (M6.6)

function writeStorage(toolId: string, data: Record<string, unknown>): void {
  const json = JSON.stringify(data)
  if (json.length > STORAGE_TOTAL_LIMIT) {
    throw bridgeError('EXEC_FAILED', `存储超出上限（${STORAGE_TOTAL_LIMIT / 1024} KB）`)
  }
  mkdirSync(join(TOOLS_DIR, toolId), { recursive: true })
  writeFileSync(storagePath(toolId), json, 'utf-8')
}

// ── http ──

async function httpRequest(params: Record<string, unknown>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const url = String(params.url ?? '')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw bridgeError('BAD_REQUEST', `无效 URL: ${url}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw bridgeError('BAD_REQUEST', '仅支持 http/https')
  if (await isBlockedHost(parsed)) throw bridgeError('EXEC_FAILED', '该地址不允许访问')

  const method = String(params.method ?? 'GET').toUpperCase()
  const headers = (params.headers && typeof params.headers === 'object' ? params.headers : {}) as Record<string, string>
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(params.timeoutMs ?? 30_000))
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: params.body != null ? String(params.body) : undefined,
      signal: controller.signal,
    })
    const body = await res.text()
    if (body.length > 2 * 1024 * 1024) {
      throw bridgeError('EXEC_FAILED', '响应超过 2MB 上限')
    }
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { resHeaders[k] = v })
    return { status: res.status, headers: resHeaders, body }
  } finally {
    clearTimeout(timeout)
  }
}

// ── fs (jailed to the tool directory) ──

function resolveToolPath(toolId: string, target: unknown): string {
  const toolDir = join(TOOLS_DIR, toolId)
  const input = String(target ?? '')
  const resolved = resolve(toolDir, input)

  // Judge the REAL location, not the spelling (review 2026-09-25 P1): a
  // nonexistent target skips plain realpath entirely, so a write through a
  // symlinked parent inside the tool dir escaped while looking legal. A
  // target that exists but cannot be resolved (dangling/loop symlink) fails
  // closed — a write would follow the link out of the judged location.
  const real = resolveRealTargetSync(resolved)
  if (real.status === 'unresolvable') {
    throw bridgeError('PATH_OUTSIDE_TOOL_DIR', 'path cannot be resolved (symlink loop or dangling link)')
  }
  // Anchor the jail on the tool dir's REAL location too — if a symlinked
  // ancestor relocates it, comparing the real target against the lexical
  // toolDir would deny every op of that tool.
  let realToolDir = toolDir
  try { realToolDir = realpathSync(toolDir) } catch { /* not created yet — lexical anchor */ }

  const decision = guardPath({
    target: resolved,
    operation: 'write', // strictest read for both read/write ops is equivalent here: deny-root check
    denyRoots: buildBaselineDenyRoots(homedir(), platform()),
    workspaceDir: realToolDir,
    realTarget: real.path,
  })
  if (!decision.ok) throw bridgeError('PATH_OUTSIDE_TOOL_DIR', decision.reason)
  return decision.resolved
}

function fsReadText(params: Record<string, unknown>, toolId: string): string {
  const p = resolveToolPath(toolId, params.path)
  if (!existsSync(p)) throw bridgeError('EXEC_FAILED', `文件不存在: ${params.path}`)
  return readFileSync(p, 'utf-8')
}

function fsWriteText(params: Record<string, unknown>, toolId: string): { ok: true } {
  const p = resolveToolPath(toolId, params.path)
  const content = String(params.text ?? '')
  if (content.length > STORAGE_TOTAL_LIMIT) throw bridgeError('EXEC_FAILED', '内容超过 1MB 上限')
  mkdirSync(join(TOOLS_DIR, toolId), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  return { ok: true }
}

function fsList(params: Record<string, unknown>, toolId: string): string[] {
  const p = resolveToolPath(toolId, params.path ?? '.')
  if (!existsSync(p)) return []
  return readdirSync(p)
}

function fsExists(params: Record<string, unknown>, toolId: string): boolean {
  return existsSync(resolveToolPath(toolId, params.path))
}

// ── dispatcher ──

async function dispatch(tool: UserTool, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'storage.get': {
      const data = readStorage(tool.id)
      return data[String(params.key ?? '')]
    }
    case 'storage.set': {
      const key = String(params.key ?? '')
      if (!key) throw bridgeError('BAD_REQUEST', 'key 不能为空')
      const value = params.value
      if (JSON.stringify(value ?? null).length > STORAGE_VALUE_LIMIT) {
        throw bridgeError('EXEC_FAILED', '单值超过 256KB 上限')
      }
      const data = readStorage(tool.id)
      data[key] = value
      writeStorage(tool.id, data)
      return { ok: true }
    }
    case 'storage.remove': {
      const data = readStorage(tool.id)
      delete data[String(params.key ?? '')]
      writeStorage(tool.id, data)
      return { ok: true }
    }
    case 'storage.keys': {
      return Object.keys(readStorage(tool.id))
    }
    case 'http.request':
      return httpRequest(params)
    case 'fs.readText':
      return fsReadText(params, tool.id)
    case 'fs.writeText':
      return fsWriteText(params, tool.id)
    case 'fs.list':
      return fsList(params, tool.id)
    case 'fs.exists':
      return fsExists(params, tool.id)
    case 'system.clipboard.write':
      clipboard.writeText(String(params.text ?? ''))
      return { ok: true }
    case 'system.clipboard.read':
      return clipboard.readText()
    case 'system.notify': {
      if (Notification.isSupported()) {
        new Notification({ title: String(params.title ?? tool.name), body: String(params.body ?? '') }).show()
      }
      return { ok: true }
    }
    case 'system.openExternal': {
      const url = String(params.url ?? '')
      if (!/^https?:\/\//.test(url)) throw bridgeError('BAD_REQUEST', '仅允许 http/https 外链')
      await shell.openExternal(url)
      return { ok: true }
    }
    default:
      throw bridgeError('UNKNOWN_METHOD', `未知方法: ${method}`)
  }
}

/**
 * Entry point for one bridge call (IPC `toolbridge:invoke`).
 * Capability check (M6.5) → dispatch → audit (M6.7). Capability errors are
 * thrown before any side effect.
 */
export async function svcToolBridgeInvoke(toolId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const started = Date.now()
  let decision = 'allowed'
  let errorText: string | undefined

  try {
    const tool = toolStore.get(toolId)
    if (!tool) throw bridgeError('BAD_REQUEST', `工具不存在: ${toolId}`)

    const required = REQUIRED_CAPABILITY[method]
    if (required === undefined) throw bridgeError('UNKNOWN_METHOD', `未知方法: ${method}`)
    if (required != null && !(tool.capabilities ?? []).includes(required as never)) {
      decision = 'denied'
      throw bridgeError('CAPABILITY_NOT_DECLARED', `该工具未声明能力 ${required}，无法调用 ${method}`)
    }

    return await dispatch(tool, method, params)
  } catch (err) {
    decision = decision === 'denied' ? 'denied' : 'failed'
    errorText = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    auditStore.record({
      scope: 'tool',
      actor: toolId,
      action: method,
      target: typeof params?.url === 'string' ? String(params.url) : typeof params?.path === 'string' ? String(params.path) : undefined,
      decision,
      metaJson: JSON.stringify({ ms: Date.now() - started, ...(errorText ? { error: errorText.slice(0, 200) } : {}) }),
    })
  }
}
