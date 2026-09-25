/**
 * Platform info service (PLAN-0.3.5 M1.4①): extracted from app.handler so the
 * agent session manager (and other non-IPC consumers) can use it without
 * dragging electron IPC into the import graph.
 */
import { platform, arch } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export function getBundledRipgrepPath(): string | null {
  const p = platform()
  const a = arch()
  const key = `${p}-${a}`
  const binaryName = p === 'win32' ? 'rg.exe' : 'rg'
  // Production: inside app resources. resourcesPath is set only under Electron;
  // plain-Node callers (vitest) skip straight to the dev path.
  const prodPath = typeof process.resourcesPath === 'string'
    ? join(process.resourcesPath, 'bin', key, binaryName)
    : null
  if (prodPath != null && existsSync(prodPath)) return prodPath
  // Dev mode: look in project resources/bin/
  const devPath = join(__dirname, '../../resources/bin', key, binaryName)
  if (existsSync(devPath)) return devPath
  return null
}

export function getPlatformName(p: string): string {
  return PLATFORM_NAMES[p] || p
}
