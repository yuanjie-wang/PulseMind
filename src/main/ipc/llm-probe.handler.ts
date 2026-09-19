import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { testLlmConnection, type LlmProbeInput } from '../services/llm-probe'

export function registerLlmProbeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LLM_TEST_CONNECTION, (_event, input: LlmProbeInput & { profileId?: string }) => testLlmConnection(input))
}
