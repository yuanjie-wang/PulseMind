/**
 * 语音输入 IPC handler（PLAN-voice-input §3.6）。
 *
 * 四个 invoke 通道 + 一个广播。转写通道吃 16k 单声道 Float32Array（渲染端
 * 已下混重采样，sampleRate 不符由 asr-recognizer 给可读错误）；模型管理走
 * model-manager（只导入），导入/删除成功后广播 ASR_MODELS_CHANGED 让所有
 * 窗口的设置页与引导卡刷新。
 */

import { ipcMain, BrowserWindow, powerSaveBlocker } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { disposeAsr, getAsrEngineStatus, transcribeSamples } from '../services/asr-recognizer'
import { cleanupTmpInstalls, importModelZip, listInstalledModels, pickInstalledModelDir, readCatalog, removeModel } from '../services/model-manager'
import { logMain } from '../main-log'

const ASR_FAMILY = 'asr'

export interface AsrStatePayload {
  engine: { dir: string; source: string; version: string; platform: string } | null
  engineError: string | null
  numThreads: number
  catalog: {
    family: string
    engineReq: string
    error: string | null
    models: Array<{
      modelId: string
      displayName: string
      version: string
      languages: string[]
      expectedZip: string
      zipSha256: string
      sizeText: string
      helpUrl: string
      installed: boolean
    }>
  }
}

export function buildAsrState(): AsrStatePayload {
  const status = getAsrEngineStatus()
  const { catalog, error } = readCatalog(ASR_FAMILY)
  const installed = new Set(listInstalledModels(ASR_FAMILY).map((m) => m.modelId))
  return {
    engine: status.engine
      ? {
          dir: status.engine.dir,
          source: status.engine.source,
          version: status.engine.version,
          platform: status.platform,
        }
      : null,
    engineError: status.engineError,
    numThreads: status.numThreads,
    catalog: {
      family: catalog?.family ?? ASR_FAMILY,
      engineReq: catalog?.engineReq ?? '',
      error,
      models: (catalog?.models ?? []).map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName,
        version: m.version,
        languages: m.languages,
        expectedZip: m.expectedZip,
        zipSha256: m.zipSha256,
        sizeText: m.sizeText,
        helpUrl: m.helpUrl,
        installed: installed.has(m.modelId),
      })),
    },
  }
}

function broadcastModelsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(IPC_CHANNELS.ASR_MODELS_CHANGED)
      } catch {
        /* window closing */
      }
    }
  }
}

export function registerAsrHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ASR_GET_STATE, (): AsrStatePayload => buildAsrState())

  ipcMain.handle(
    IPC_CHANNELS.ASR_TRANSCRIBE,
    async (_event, samples: Float32Array, sampleRate: number, opts?: { language?: string }): Promise<{ text: string; ms: number }> => {
      const model = pickInstalledModelDir(ASR_FAMILY)
      if (!model) {
        throw new Error('尚未导入语音模型——请在设置 → 语音输入中导入模型包')
      }
      // 录音阶段的防睡由 OS 的音频捕获断言兜着；转写是纯 CPU 工作、音频断言
      // 已随录音停止而消失，这里补一个（秒级，无条件，无需设置项——keep-awake
      // 的会话级开关管的是长跑任务，不覆盖这条几秒钟的推理）。
      let blockerId: number | null = null
      try {
        if (typeof powerSaveBlocker?.start === 'function') {
          blockerId = powerSaveBlocker.start('prevent-app-suspension')
        }
      } catch {
        /* stubbed runtime / 平台不支持 → 无阻塞转写 */
      }
      try {
        const r = await transcribeSamples(samples, sampleRate, model.dir, {
          language: opts?.language,
        })
        if (!r.text.trim()) {
          logMain('INFO', 'asr', `transcribe empty result (${r.ms}ms, model=${model.modelId})`)
        }
        return r
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logMain('WARN', 'asr', `transcribe failed: ${msg}`)
        throw e
      } finally {
        if (blockerId != null) {
          try {
            powerSaveBlocker.stop(blockerId)
          } catch {
            /* already stopped */
          }
        }
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.ASR_IMPORT_MODEL, async (_event, zipPath: string) => {
    // 换装前必须先释放 worker（review 20261120 M1）：转写过至少一次后 worker
    // 活着，Windows 上 ONNX Runtime 保持 model.int8.onnx 打开/映射，
    // importModelZip 的整目录删除会 EBUSY/EPERM 且递归删中途死、无回滚——
    // 重导同一模型（升级场景）反而把能用的安装搞坏。同 remove 臂的纪律；
    // await 到 terminate 真完成（句柄已放）才动盘；worker 重建成本仅一次 init。
    await disposeAsr()
    const result = await importModelZip(ASR_FAMILY, zipPath)
    if (result.ok) {
      logMain('INFO', 'asr', `model imported: ${result.modelId}`)
      broadcastModelsChanged()
    } else {
      logMain('WARN', 'asr', `import rejected (${result.status}): ${result.message}`)
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.ASR_REMOVE_MODEL, async (_event, modelId: string): Promise<boolean> => {
    // 与导入臂同一条纪律：worker 活着时 ONNX Runtime 保持 model.int8.onnx
    // 打开/映射，Windows 上先动盘会 EBUSY/EPERM。此前这里是「先 rmSync 删盘、
    // 再 void disposeAsr()」——顺序正好反了，且 removeModel 无 try/catch：
    // 删不掉时异常直接抛给渲染端，Modal 静默无提示、广播也不发（设置页删完
    // 仍显示已安装）。改为先 await 到 terminate 真完成，再动盘。
    await disposeAsr()
    try {
      const removed = removeModel(ASR_FAMILY, modelId)
      if (removed) {
        logMain('INFO', 'asr', `model removed: ${modelId}`)
      } else {
        logMain('WARN', 'asr', `model remove skipped (not found or unsafe id): ${modelId}`)
      }
      // 成败都广播：失败时界面也需要回到磁盘上的真实状态
      broadcastModelsChanged()
      return removed
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logMain('WARN', 'asr', `model remove failed: ${msg}`)
      throw new Error(`删除模型失败：${msg}。请关闭可能占用该模型文件的程序后重试。`)
    }
  })
}

/** 启动清扫：安装中掉电留下的 tmp 残留（index.ts 启动段调用） */
export function cleanupAsrTmpInstalls(): void {
  const removed = cleanupTmpInstalls(ASR_FAMILY)
  if (removed > 0) logMain('INFO', 'asr', `cleaned ${removed} tmp install(s)`)
}
