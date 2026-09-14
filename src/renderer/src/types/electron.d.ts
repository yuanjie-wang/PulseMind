// ── ElectronAPI ambient declaration ──
// The contract itself (ElectronAPI + all IPC payload types) lives in
// src/shared/types/electron-bridge.ts — single home for the three-layer
// surface, importable by preload and main without crossing into renderer
// code. This file only re-exports it for renderer-side consumers and keeps
// the ambient Window declaration the renderer relies on.

import type { ElectronAPI } from '../../../shared/types/electron-bridge'

export * from '../../../shared/types/electron-bridge'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
  // Vite define (vite.config.ts). This file is a module (type-only imports above),
  // so the declaration has to live in `declare global` to be visible everywhere.
  var __APP_VERSION__: string
}
