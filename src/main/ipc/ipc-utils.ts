import type { IpcMainInvokeEvent } from 'electron'

/**
 * Wrap an IPC handler with try-catch error handling.
 * Returns a consistent `{ success, data, error }` shape.
 * The handler function receives only the IPC args (no _event).
 */
export function withErrorResponse<R>(
  fn: (...args: any[]) => R | Promise<R>
) {
  return async (_event: IpcMainInvokeEvent, ...args: any[]): Promise<{ success: boolean; data?: R; error?: string }> => {
    try {
      const data = await fn(...args)
      return { success: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] error:`, err)
      return { success: false, error: message }
    }
  }
}

/**
 * Wrap a void IPC handler with try-catch logging.
 * For handlers that don't return a value but should log errors.
 */
export function withErrorLogging(
  fn: (...args: any[]) => void | Promise<void>
) {
  return async (_event: IpcMainInvokeEvent, ...args: any[]): Promise<void> => {
    try {
      await fn(...args)
    } catch (err) {
      console.error(`[IPC] error:`, err)
    }
  }
}
