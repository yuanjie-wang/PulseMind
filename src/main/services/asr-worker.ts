/**
 * ASR 推理 worker（worker_threads，PLAN-voice-input §3.4）。
 *
 * sherpa-onnx 推理是持续 CPU 工作（SenseVoice int8 全模型驻留内存），必须
 * 离开主进程事件循环——流式化之后更是硬要求。worker 内 require 引擎 addon
 * 并建 recognizer；主进程只传 `{samples: Float32Array}`（transferable，零拷贝）
 * 收 `{text}`。音频全程内存态，worker 里也不落盘。
 *
 * 引擎/模型路径由主进程在 init 消息里给出（加载器的三级回落与 sha 门都在
 * 主进程侧跑过），worker 只管推理。构建：scripts/build.js 单独 entry →
 * out/main/asr-worker.js（与 extract-worker 同款）。
 *
 * 直接用 addon 的裸 C API（不用 sherpa-onnx-node 的 JS wrapper）：打包态没有
 * node_modules，wrapper 的相对 require 解析不到平台包。用到的五个函数：
 *   createOfflineRecognizer / createOfflineStream / acceptWaveformOffline /
 *   decodeOfflineStream / getOfflineStreamResultAsJson
 */

import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'

interface InitMsg {
  type: 'init'
  engineDir: string
  modelDir: string
  numThreads: number
  /** SenseVoice language hint：auto/zh/en/ja/ko/yue（M0-5 定参） */
  language: string
  /** SenseVoice ITN（数字规整），M0-5 定参缺省开 */
  useInverseTextNormalization: number
}

interface TranscribeMsg {
  type: 'transcribe'
  id: number
  samples: Float32Array
  sampleRate: number
}

interface DisposeMsg {
  type: 'dispose'
}

type WorkerMsg = InitMsg | TranscribeMsg | DisposeMsg

interface AsrAddon {
  createOfflineRecognizer(config: unknown): unknown
  createOfflineStream(recognizer: unknown): unknown
  acceptWaveformOffline(stream: unknown, wave: { samples: Float32Array; sampleRate: number }): void
  decodeOfflineStream(recognizer: unknown, stream: unknown): void
  getOfflineStreamResultAsJson(stream: unknown): string
}

interface AsrRecognizerHandle {
  handle: unknown
  addon: AsrAddon
}

let recognizer: AsrRecognizerHandle | null = null

function init(msg: InitMsg): void {
  const addon = require(join(msg.engineDir, 'sherpa-onnx.node')) as AsrAddon
  const handle = addon.createOfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(msg.modelDir, 'model.int8.onnx'),
        language: msg.language,
        useInverseTextNormalization: msg.useInverseTextNormalization,
      },
      tokens: join(msg.modelDir, 'tokens.txt'),
      numThreads: msg.numThreads,
      debug: 0,
      provider: 'cpu',
    },
  })
  recognizer = { handle, addon }
}

function post(msg: unknown): void {
  parentPort?.postMessage(msg)
}

parentPort?.on('message', (msg: WorkerMsg) => {
  if (msg.type === 'init') {
    try {
      init(msg)
      post({ type: 'ready' })
    } catch (e) {
      recognizer = null
      post({ type: 'init-error', message: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  if (msg.type === 'transcribe') {
    if (!recognizer) {
      post({ type: 'error', id: msg.id, message: 'ASR worker not initialized' })
      return
    }
    try {
      const { handle, addon } = recognizer
      const stream = addon.createOfflineStream(handle)
      addon.acceptWaveformOffline(stream, { samples: msg.samples, sampleRate: msg.sampleRate })
      addon.decodeOfflineStream(handle, stream)
      // getOfflineStreamResultAsJson 实测形态（2.0.2 + SenseVoice）：
      // {"lang":"<|zh|>","emotion":…,"text":"…","timestamps":[…],…} —— text 是
      // 顶层字符串，标点与 ITN 已含在内。
      const result = JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as { text?: string }
      post({ type: 'result', id: msg.id, text: result.text ?? '' })
    } catch (e) {
      post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  if (msg.type === 'dispose') {
    // recognizer 的原生内存随进程消失，直接退出最干净
    process.exit(0)
  }
})
