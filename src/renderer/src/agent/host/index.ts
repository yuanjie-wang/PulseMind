import type { ElectronAPI } from '../../types/electron'
import type { PulseHost } from './types'

let current: PulseHost | null = null

/**
 * The host backing the agent graph. Lazily defaults to the renderer bridge so
 * existing construction sites work unchanged; tests and the main-process host
 * (M1.4) call setHost() before any engine runs.
 */
export function getHost(): PulseHost {
  if (!current) {
    if (typeof window === 'undefined' || !window.electronAPI) {
      throw new Error('Agent host not initialized — call setHost() before using the agent graph')
    }
    current = createRendererHost(window.electronAPI)
  }
  return current
}

/** Explicitly install a host (main-process implementation, test mocks). */
export function setHost(host: PulseHost): void {
  current = host
}

/** The renderer host is the structural subset of the ElectronAPI itself. */
export function createRendererHost(ea: ElectronAPI): PulseHost {
  return ea
}
