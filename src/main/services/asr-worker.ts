/**
 * ASR 推理子进程入口（PLAN-voice-input §3.4；2026-11-24 起跑在独立 OS 进程里）。
 *
 * sherpa-onnx 推理是持续 CPU 工作（SenseVoice int8 全模型驻留内存），必须离开
 * 主进程事件循环。**更重要的是离开主进程的地址空间**：Linux 上「点停止即闪退、
 * 零日志」的事故形态只有原生层连坐整个进程才解释得通（worker_threads 与主进程
 * 同进程，abort/SIGSEGV/OOM-kill 一条 JS 日志都留不下）。现在宿主是 Electron
 * `utilityProcess`（纯 Node 环境回落 worker_threads，见 asr-host.ts / asr-port.ts），
 * 引擎崩了只死子进程，退出码与 stderr 都会进 `logs/main.log`。
 *
 * worker 内 require 引擎 addon 并建 recognizer；主进程只传
 * `{samples: Float32Array}` 收 `{text}`（utilityProcess 不能转移 ArrayBuffer，
 * 结构克隆拷贝一份；320KB/5s 可忽略）。音频全程内存态，worker 里也不落盘。
 *
 * 引擎/模型路径由主进程在 init 消息里给出（三级回落与 sha 门都在主进程侧跑过），
 * worker 只管推理。构建：scripts/build.js 单独 entry → out/main/asr-worker.js。
 *
 * 直接用 addon 的裸 C API（不用 sherpa-onnx-node 的 JS wrapper）：打包态没有
 * node_modules，wrapper 的相对 require 解析不到平台包。用到的五个函数：
 *   createOfflineRecognizer / createOfflineStream / acceptWaveformOffline /
 *   decodeOfflineStream / getOfflineStreamResultAsJson
 */

import { join } from 'node:path'
import { openChildPort } from './asr-port'
import { loadAsrAddon } from './asr-engine'

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

type WorkerMsg = InitMsg | TranscribeMsg

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

const port = openChildPort()

let recognizer: AsrRecognizerHandle | null = null

/**
 * 里程碑只走 stderr：utilityProcess 以 `stdio: 'pipe'` 拉起，宿主按行收进
 * main.log —— 崩在原生层时这几行就是最后现场（JS 侧没有任何回调会到）。
 */
function trace(line: string): void {
  process.stderr.write(`[asr] ${line}\n`)
}

/**
 * 加载 addon：走加载器的统一入口，dlopen 失败得到的是「引擎加载失败（linux-x64）：
 * …；常见原因：安装包不完整 / 杀软拦截 / 与系统库不兼容」这种可读文案，
 * 而不是裸的 undefined symbol。以前这步在主进程，现在它在子进程里——同一句
 * 话现在只出现在 init-error 消息和 stderr 里，应用继续活着。
 */
function init(msg: InitMsg): void {
  const t0 = Date.now()
  trace(`${port.channel} init: engine=${msg.engineDir}`)
  const addon = loadAsrAddon(msg.engineDir) as AsrAddon
  trace(`addon loaded in ${Date.now() - t0}ms`)
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
  trace(`recognizer ready in ${Date.now() - t0}ms (threads=${msg.numThreads})`)
}

function post(msg: unknown): void {
  port.postMessage(msg)
}

port.onMessage((raw) => {
  const msg = raw as WorkerMsg
  if (msg.type === 'init') {
    try {
      init(msg)
      post({ type: 'ready' })
    } catch (e) {
      recognizer = null
      const message = e instanceof Error ? e.message : String(e)
      trace(`init failed: ${message}`)
      post({ type: 'init-error', message })
    }
    return
  }
  if (msg.type === 'transcribe') {
    if (!recognizer) {
      post({ type: 'error', id: msg.id, message: 'ASR worker not initialized' })
      return
    }
    const t0 = Date.now()
    trace(`decode start: samples=${msg.samples.length}`)
    try {
      const { handle, addon } = recognizer
      const stream = addon.createOfflineStream(handle)
      addon.acceptWaveformOffline(stream, { samples: msg.samples, sampleRate: msg.sampleRate })
      addon.decodeOfflineStream(handle, stream)
      // getOfflineStreamResultAsJson 实测形态（2.0.2 + SenseVoice）：
      // {"lang":"<|zh|>","emotion":…,"text":"…","timestamps":[…],…} —— text 是
      // 顶层字符串，标点与 ITN 已含在内。
      const result = JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as { text?: string }
      const text = result.text ?? ''
      trace(`decode done in ${Date.now() - t0}ms chars=${text.length}`)
      post({ type: 'result', id: msg.id, text })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      trace(`decode failed in ${Date.now() - t0}ms: ${message}`)
      post({ type: 'error', id: msg.id, message })
    }
  }
})
