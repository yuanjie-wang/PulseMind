// ── 语音输入全链路接线扫描（PLAN-voice-input M1/M2/M3）──
// packed-node-modules 同款纪律：装配形状用源码扫描钉住（IO/渲染端行为由探针
// 与冒烟钉）。负扫：sherpa-onnx-* 绝不进 dependencies（P4——electron-builder
// 照单全收打进 asar，体积红线）。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

describe('依赖纪律（P4）', () => {
  it('dependencies 里不得出现 sherpa-onnx-*（会进 asar）', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(name).not.toMatch(/^sherpa-onnx/)
    }
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('sherpa-onnx-node')
  })

  it('build.js 把 asr-worker 打成独立 entry（out/main/asr-worker.js）', () => {
    const build = read('scripts', 'build.js')
    expect(build).toContain('src/main/services/asr-worker.ts')
    expect(build).toContain('out/main/asr-worker.js')
  })

  it('resources/asr-engine 进 gitignore（CI/dev 由脚本生成，同 chromium 纪律）', () => {
    expect(read('.gitignore')).toContain('resources/asr-engine/')
  })
})

describe('IPC 三件套', () => {
  it('五个通道在 shared/ipc-channels.ts', () => {
    const ch = read('src/shared/ipc-channels.ts')
    for (const key of ['ASR_GET_STATE', 'ASR_TRANSCRIBE', 'ASR_IMPORT_MODEL', 'ASR_REMOVE_MODEL', 'ASR_MODELS_CHANGED']) {
      expect(ch).toContain(`${key}:`)
    }
  })

  it('preload 暴露 asr* API + 广播订阅（unsub 返回卸载函数）', () => {
    const preload = read('src/preload/index.ts')
    for (const fn of ['asrGetState', 'asrTranscribe', 'asrImportModel', 'asrRemoveModel', 'onAsrModelsChanged']) {
      expect(preload).toContain(`${fn}:`)
    }
    expect(preload).toContain('IPC_CHANNELS.ASR_MODELS_CHANGED, handler')
  })

  it('electron-bridge 声明同名方法', () => {
    const bridge = read('src/shared/types/electron-bridge.ts')
    for (const fn of ['asrGetState', 'asrTranscribe', 'asrImportModel', 'asrRemoveModel', 'onAsrModelsChanged']) {
      expect(bridge).toContain(`${fn}:`)
    }
  })

  it('handler 注册进 registerIpcHandlers', () => {
    const index = read('src/main/ipc/index.ts')
    expect(index).toContain("import { registerAsrHandlers } from './asr.handler'")
    expect(index).toContain('registerAsrHandlers()')
  })

  it('启动清扫（tmp 安装残留）挂进 index.ts 启动段', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('cleanupAsrTmpInstalls()')
  })

  it('worker 的推理出口与主进程转写入口对齐（id/text/error 协议）', () => {
    const worker = read('src/main/services/asr-worker.ts')
    const recognizer = read('src/main/services/asr-recognizer.ts')
    // worker 回三种消息，主进程各有一臂
    for (const kind of ["type: 'ready'", "type: 'init-error'", "type: 'result'", "type: 'error'"]) {
      expect(worker).toContain(kind)
    }
    for (const kind of ["m.type === 'ready'", "m.type === 'init-error'", "m.type === 'result' || m.type === 'error'"]) {
      expect(recognizer).toContain(kind)
    }
  })
})

describe('media 权限门', () => {
  it('index.ts 安装 handler（request + check 两侧）且只收 media', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('installMediaPermissionHandlers()')
    const mod = read('src/main/media-permissions.ts')
    expect(mod).toContain('setPermissionRequestHandler')
    expect(mod).toContain('setPermissionCheckHandler')
    expect(mod).toContain("permission === 'media'")
    expect(mod).toContain('askForMediaAccess')
  })
})

describe('打包接线', () => {
  it('三个平台段的 extraResources 都带 asr-engine filter（本平台架构）', () => {
    const pkg = read('package.json')
    for (const filter of ['darwin-${arch}/**', 'win32-${arch}/**', 'linux-${arch}/**']) {
      expect(pkg).toContain(`"from": "resources/asr-engine"`)
    }
    const build = JSON.parse(read('package.json')) as {
      build: {
        mac: { extraResources: Array<{ from: string; filter?: string[] }> }
        win: { extraResources: Array<{ from: string; filter?: string[] }> }
        linux: { extraResources: Array<{ from: string; filter?: string[] }> }
      }
    }
    for (const [section, suffix] of [
      ['mac', 'darwin-'],
      ['win', 'win32-'],
      ['linux', 'linux-'],
    ] as const) {
      const entry = build.build[section].extraResources.find((r) => r.from === 'resources/asr-engine')
      expect(entry, `${section} 段缺 asr-engine entry`).toBeDefined()
      expect(entry?.filter?.some((f) => f.startsWith(suffix))).toBe(true)
    }
  })

  it('mac extendInfo 带 NSMicrophoneUsageDescription', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { mac: { extendInfo?: Record<string, string> } } }
    expect(pkg.build.mac.extendInfo?.NSMicrophoneUsageDescription).toBeTruthy()
  })

  it('check-linux-glibc 扫 .so（随包引擎的 libonnxruntime.so 等入罩）', () => {
    expect(read('scripts/check-linux-glibc.js')).toContain("endsWith('.so')")
  })

  it('prepare/smoke 脚本在位且 smoke 驱动产品代码', () => {
    expect(read('scripts/prepare-asr-engine.js')).toContain('manifest.json')
    const smoke = read('scripts/smoke-packed-asr.js')
    expect(smoke).toContain('asr-recognizer.ts')
    expect(smoke).toContain('transcribeSamples')
    expect(smoke).toContain('PULSEMIND_ASR_ENGINE')
  })
})

describe('渲染端接线', () => {
  it('InputArea：麦克风按钮 + 引导卡 + ⌥V + 光标插入 + features.voice', () => {
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('useVoiceInput')
    expect(input).toContain('VoiceGuideCard')
    expect(input).toContain('features?.voice ?? features === undefined')
    expect(input).toContain("e.code !== 'KeyV'")
    expect(input).toContain('insertVoiceText')
  })

  it('useVoiceInput 的录音形态（getUserMedia + MediaRecorder opus + Esc 取消）', () => {
    const hook = read('src/renderer/src/components/chat/useVoiceInput.ts')
    expect(hook).toContain('getUserMedia')
    expect(hook).toContain('audio/webm;codecs=opus')
    expect(hook).toContain("'Escape'")
    expect(hook).toContain('asrTranscribe')
    expect(hook).toContain('onAsrModelsChanged')
  })

  it('设置页：VoiceSettings 挂进 SettingsPage（菜单 + renderSection + settingsTab 类型）', () => {
    expect(read('src/renderer/src/components/settings/SettingsPage.tsx')).toContain('VoiceSettings')
    expect(read('src/renderer/src/navigation/types.ts')).toContain("'voice'")
  })

  it('i18n 两 locale 都有 voiceInput 节（键集同形，防单侧漂移）', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    const zhKeys = [...zh.matchAll(/^    (\w+):/gm)].map((m) => m[1])
    expect(zh).toContain('voiceInput: {')
    expect(en).toContain('voiceInput: {')
    for (const key of [
      'micStart',
      'micStop',
      'guideTitle',
      'guideImport',
      'imported',
      'settingsTitle',
      'languageHint',
      'emptyResult',
      'permissionDenied',
      'noMicrophone',
    ]) {
      expect(zh).toMatch(new RegExp(`\\b${key}:`))
      expect(en).toMatch(new RegExp(`\\b${key}:`))
    }
    void zhKeys
  })

  it('模型清单随包且 family=asr', () => {
    const models = JSON.parse(read('resources/asr/models.json')) as { family: string; models: unknown[] }
    expect(models.family).toBe('asr')
    expect(models.models.length).toBeGreaterThan(0)
  })

  it('转写 wav 夹具随包（smoke 的真转写段输入）', () => {
    const p = join(REPO, 'resources', 'asr', 'fixtures', 'zh.wav')
    const head = readFileSync(p).subarray(0, 4).toString('ascii')
    expect(head).toBe('RIFF')
  })
})
