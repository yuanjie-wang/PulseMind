import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

export interface ShowDialogOptions {
  type: 'choice' | 'prompt'
  title: string
  message: string
  choices?: string[]
}

export interface ShowDialogResult {
  value: string | null
  cancelled: boolean
}

/**
 * Register IPC handler for showing native dialogs.
 *
 * - `choice`: Uses `dialog.showMessageBox` with buttons mapped to choices.
 * - `prompt`: Uses `dialog.showMessageBox` with an input-style layout (no native
 *   text input — this is a limitation of Electron's dialog API; the caller can
 *   fall back to a shell-based prompt on platforms that support it).
 */
export function registerDialogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SHOW,
    async (_event, options: ShowDialogOptions): Promise<ShowDialogResult> => {
      const win = BrowserWindow.getFocusedWindow()

      if (options.type === 'choice' && options.choices && options.choices.length > 0) {
        const result = await dialog.showMessageBox(win ?? undefined, {
          type: 'question',
          title: options.title,
          message: options.message,
          detail: 'Make a selection:',
          buttons: options.choices,
          cancelId: options.choices.length - 1,
          noLink: true
        })
        return {
          value: result.response >= 0 ? options.choices[result.response] : null,
          cancelled: result.response === -1
        }
      }

      // Free-text prompt — Electron dialog has no native text input, so show
      // a simple OK / Cancel and return an empty string as a signal to the
      // caller that it needs to use an alternative input method.
      const result = await dialog.showMessageBox(win ?? undefined, {
        type: 'question',
        title: options.title,
        message: options.message,
        detail: 'Enter your response in the chat.',
        buttons: ['OK (reply in chat)', 'Cancel'],
        cancelId: 1
      })
      return {
        value: result.response === 0 ? '__USE_CHAT_INPUT__' : null,
        cancelled: result.response !== 0
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SHOW_SAVE,
    async (
      _event,
      options: { defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }
    ): Promise<{ filePath: string | null; canceled: boolean }> => {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win ?? undefined, {
        defaultPath: options.defaultName,
        filters: options.filters
      })
      return {
        filePath: result.filePath ?? null,
        canceled: result.canceled
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SHOW_OPEN,
    async (
      _event,
      options: { properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>; filters?: Array<{ name: string; extensions: string[] }> }
    ): Promise<{ filePaths: string[]; canceled: boolean }> => {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showOpenDialog(win ?? undefined, {
        properties: options.properties ?? ['openFile'],
        filters: options.filters
      })
      return {
        filePaths: result.filePaths,
        canceled: result.canceled
      }
    }
  )
}
