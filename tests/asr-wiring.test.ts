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

  it('导入臂：换装前先释放 worker + 全异步（review 20261120 M1/M2）', () => {
    const handler = read('src/main/ipc/asr.handler.ts')
    expect(handler).toMatch(/ASR_IMPORT_MODEL, async/)
    // Windows 上 ORT 保持 model.int8.onnx 打开：先 await 到 terminate 完成
    // 才允许 importModelZip 动盘（重导入不砸已装模型）
    expect(handler).toContain('await disposeAsr()')
    expect(handler).toContain('await importModelZip')
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
    for (const _filter of ['darwin-${arch}/**', 'win32-${arch}/**', 'linux-${arch}/**']) {
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

  it('随包清单进全局 extraResources（review 20261120 H1：候选梯的打包侧）', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { extraResources: Array<{ from: string; to: string; filter?: string[] }> } }
    const entry = pkg.build.extraResources.find((r) => r.from === 'resources/asr')
    expect(entry, '全局 extraResources 缺 resources/asr → 打包态模型清单不可达（H1 回归）').toBeDefined()
    expect(entry?.to).toBe('asr')
    expect(entry?.filter).toContain('models.json')
  })

  it('model-manager 的清单候选梯（env 缝 → resourcesPath → dev）+ 流式 hash', () => {
    const mm = read('src/main/services/model-manager.ts')
    expect(mm).toContain('PULSEMIND_ASR_CATALOG')
    expect(mm).toContain("join(resourcesPath, 'asr', 'models.json')")
    // M2：240MB 级 sha256 不许整文件 readFileSync 进 Buffer
    expect(mm).toContain('createReadStream')
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
    // H1 回归钉：打包态 readCatalog 断言（model-manager bundle + resourcesPath 假体）
    expect(smoke).toContain('model-manager.ts')
    expect(smoke).toContain('readCatalog')
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

  it('麦克风 hover 提示带触发快捷键（2026-11-22，formatAccelerator 平台词汇）', () => {
    // 平台化展示收敛在一个助手（mac ⌥V / 其余 Alt+V，shared/shortcuts 同一 formatter）——
    // 别再手写 ⌥V 字面量进展示面
    const util = read('src/renderer/src/utils/shortcut-display.ts')
    expect(util).toContain("formatAccelerator('Alt+V'")
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('voiceShortcutLabel()')
    expect(input).toContain("t('voiceInput.micStartTip'")
    expect(input).toContain("t('voiceInput.micStopTip'")
    // 转写中不给快捷键（⌥V 在该相位无事可做）
    expect(input).toContain("voice.state.phase === 'transcribing'\n                        ? t('voiceInput.micTranscribing')")
    // 设置页 hint 同源插值（composer 与设置页词汇必须一致）
    const settings = read('src/renderer/src/components/settings/VoiceSettings.tsx')
    expect(settings).toContain("t('voiceInput.shortcutHint', { shortcut: voiceShortcutLabel() })")
    // 两 locale 都不留 ⌥V 字面量（占位符形态是平台词汇的唯一入口）
    for (const loc of ['src/renderer/src/i18n/locales/zh.ts', 'src/renderer/src/i18n/locales/en.ts']) {
      const text = read(loc)
      expect(text).toContain('shortcutHint:')
      expect(text).not.toMatch(/shortcutHint: '.*⌥V/)
    }
  })

  it('引导卡的消失契约（user 2026-11-20：受控 Popover 不会自己收，三个契机必须接线）', () => {
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    // overlayClassName 是外部点击判定的锚点（内容在 body portal，靠 DOM 判内外）
    expect(input).toContain('pm-voice-guide')
    // 点外部：document 级 pointerdown 捕获 + mic 按钮与卡内豁免
    expect(input).toContain("addEventListener('pointerdown', onDocPointerDown, true)")
    expect(input).toContain('micBtnRef.current?.contains(target)')
    expect(input).toContain("target.closest('.pm-voice-guide')")
    // Esc 收卡 + 再按麦克风 toggle
    expect(input).toContain('if (voice.state.guideVisible) voice.dismissGuide()')
    expect(input).toContain('if (e.key !== \'Escape\') return')
  })

  it('useVoiceInput 的采集形态（AudioWorklet 16k PCM，不再走 MediaRecorder）', () => {
    const hook = read('src/renderer/src/components/chat/useVoiceInput.ts')
    expect(hook).toContain('getUserMedia')
    expect(hook).toContain('AudioWorkletNode')
    expect(hook).toContain("addModule('./pcm-tap.worklet.js')")
    expect(hook).toContain("'pm-pcm-tap'")
    expect(hook).toContain('createSegmenter')
    expect(hook).toContain('SAMPLE_RATE = 16000')
    expect(hook).toContain('asrTranscribe')
    expect(hook).toContain('onAsrModelsChanged')
    expect(hook).toContain("'Escape'")
    // MediaRecorder 产出 webm/opus 容器，必须整段编码完才能解码——与「逐段出字」
    // 天然互斥，别有人把它加回来
    expect(hook).not.toContain('new MediaRecorder')
    expect(hook).not.toContain('audio/webm')
    // blob: URL 会被生产 CSP(script-src 'self') 拦掉（2026-11-22 阶段 0 实测）
    expect(hook).not.toContain('createObjectURL')
  })

  it('pcm-tap worklet 是 public/ 下的真实静态资源（blob: 会被 CSP 拦）', () => {
    const worklet = read('src/renderer/public/pcm-tap.worklet.js')
    expect(worklet).toContain('class PcmTap extends AudioWorkletProcessor')
    expect(worklet).toContain("registerProcessor('pm-pcm-tap'")
    // 批量投递后再切片复制：直接 post 复用的 buffer 会把后续写入带过去
    expect(worklet).toContain('this.buf.slice(')
  })

  it('听写期间锁输入框（user 2026-11-22：不允许手动编辑）', () => {
    // 选 readOnly 而不是 disabled：disabled 会把文字变灰、断掉选中复制，而听写要
    // 持续数秒——用户得能看着已转出的文字、也要能选中它
    const composer = read('src/renderer/src/components/chat/Composer.tsx')
    expect(composer).toContain('readOnly?: boolean')
    expect(composer).toContain('readOnly={readOnly}')
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain("readOnly={voice.state.phase !== 'idle'}")
    // 转写态必须有退出路径（此前 Esc 只挂 recording，按钮也不处理 transcribing）
    expect(input).toContain("voice.state.phase === 'transcribing') voice.cancel()")
  })

  it('录音期间语音按钮形态恒定（user 2026-11-22：分段识别时不要抖动）', () => {
    const hook = read('src/renderer/src/components/chat/useVoiceInput.ts')
    // 秒数每秒 setState 不仅改宽按钮，还会把整棵 InputAreaImpl 重渲一遍
    expect(hook).not.toContain('setSeconds')
    // 「有段在转写中」在边录边转时反复进出，同样让按钮内容忽有忽无
    expect(hook).not.toContain('setRecognizing')
    // 不设录音时长上限（user 2026-11-22 裁定）：每段独立转写，尾延迟只看最后
    // 一段；硬停只会打断正常的长口述。hook 里因此也不该再留任何 setInterval
    // ——计时显示在 VoiceElapsed 自己身上，那是界面的事，与采集链路无关
    expect(hook).not.toContain('MAX_RECORD_SECONDS')
    expect(hook).not.toContain('setInterval')
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).not.toContain('voice.state.seconds')
    expect(input).not.toContain('voice.state.recognizing')
    // 秒数照旧显示，但不能直接在按钮里塞裸文本：独立小组件自计时 + 固定 minWidth
    // + tabular-nums，读数每秒在变而按钮宽度一秒不变（user 2026-11-22）
    expect(input).toContain('const VoiceElapsed = React.memo')
    expect(input).toContain('minWidth: 32')
    expect(input).toContain('fontVariantNumeric')
    expect(input).toContain("voice.state.phase === 'recording' && <VoiceElapsed />")
    // 按钮文字只在用户点停之后的 transcribing 态出现
    expect(input).toContain("voice.state.phase === 'transcribing' && (")
  })

  it('录音时输入区边框呼吸、阴影转红（user 2026-11-22：阴影也要变、更偏红）', () => {
    const composer = read('src/renderer/src/components/chat/Composer.tsx')
    expect(composer).toContain("voicePhase?: 'idle' | 'recording' | 'transcribing'")
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('voicePhase={voice.state.phase}')
    // 边框呼吸 = 静止的浅灰 → 录音红。关键约束是「只动颜色」：卡片高度被测量
    // 用于对话区底部留白，任何尺寸属性混进关键帧都会让整个布局跟着抖。
    const breath = composer.match(/@keyframes pm-voice-breath \{([\s\S]*?)\n {8}\}/)?.[1] ?? ''
    expect(breath).toContain('border-color: var(--pm-border-veil)')
    expect(breath).toContain('border-color: var(--pm-rec-accent)')
    expect([...new Set([...breath.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))]).toEqual(['border-color'])
    // 发光走 ::after，不走卡片自己的 box-shadow：基线上那条带 !important，
    // 而「重要作者声明」在级联里高于动画声明——写在那里会静默失效。
    const glow = composer.match(/@keyframes pm-voice-glow \{([\s\S]*?)\n {8}\}/)?.[1] ?? ''
    expect([...new Set([...glow.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))]).toEqual(['opacity'])
    expect(composer).toContain('box-shadow: 0 5px 20px 2px var(--pm-rec-glow)')
    // 转写态（麦克风已关）保持静态红边与发光，不继续呼吸
    expect(composer).toContain('.pm-composer-root.pm-voice-busy .ant-sender {')
    expect(composer).toContain('.pm-composer-root.pm-voice-busy .ant-sender::after {')
    expect(composer).toContain('animation: pm-voice-breath 2.4s ease-in-out infinite')
    expect(composer).toContain('animation: pm-voice-glow 2.4s ease-in-out infinite')
    // 减少动效下停掉呼吸，但红色边框与发光必须留着——否则录音就没了可见指示
    expect(composer).toContain('.pm-composer-root.pm-voice-recording .ant-sender { animation: none; }')
    expect(composer).toContain('.pm-composer-root.pm-voice-recording .ant-sender::after { animation: none; }')
    // 暖金还给状态点：录音色不再是 gold
    expect(composer).not.toContain('border-color: var(--pm-gold-accent)')
  })

  it('语音插入用冻结锚点，不读实时选区（user 2026-11-22：光标不可见却能移动）', () => {
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    // readonly textarea 不绘制 caret，但点击/方向键仍能移动选区。插入点若跟着
    // 实时选区走，听写中随手点一下中间就会插错位置；点成「选中一段」更糟——
    // slice(0,start)+text+slice(end) 会把选中内容整段替换掉，用户没编辑、
    // 自己写的字却消失了。
    expect(input).toContain('voiceAnchorRef')
    const from = input.indexOf('const insertVoiceText')
    const insertBody = input.slice(from, input.indexOf('}, [])', from))
    expect(insertBody).not.toContain('ta.selectionStart')
    expect(insertBody).not.toContain('ta.selectionEnd')
    // end 恒等于 start：只插入、永不替换
    expect(insertBody).toContain('const end = start')
    // 锚点在进入录音时取一次，回到 idle 清空
    expect(input).toContain("voice.state.phase === 'recording'")
    expect(input).toContain('voiceAnchorRef.current = null')
  })

  it('取消听写回滚草稿（Esc 语义 = 当这次没发生）', () => {
    const hook = read('src/renderer/src/components/chat/useVoiceInput.ts')
    expect(hook).toContain('draftSnapshotRef')
    expect(hook).toContain('writeDraftRef.current?.(snapshot)')
    // 快照在开录成功之后取：麦克风被拒时不该留下一个可回滚的假快照
    expect(hook).toContain('draftSnapshotRef.current = readDraftRef.current ? readDraftRef.current() : null')
    // finish() 会清空快照，cancel 必须先取再 finish——顺序反了就回滚不到。
    // 比位置前先剥掉注释行：注释里提到 finish() 会让 indexOf 指到注释上（本断言
    // 第一版正是这样误报的，比较的是两行注释）。切片也收到 cancel 函数体为止。
    const cancelBody = hook.slice(hook.indexOf('const cancel = useCallback'), hook.indexOf('const start = useCallback'))
    const cancelCode = cancelBody
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(cancelCode.indexOf('draftSnapshotRef.current')).toBeLessThan(cancelCode.indexOf('finish()'))
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('readDraft: () => inputValueRef.current')
    expect(input).toContain('writeDraft: writeVoiceDraft')
  })

  it('设置页：VoiceSettings 挂进 SettingsPage（菜单 + renderSection + settingsTab 类型）', () => {
    expect(read('src/renderer/src/components/settings/SettingsPage.tsx')).toContain('VoiceSettings')
    expect(read('src/renderer/src/navigation/types.ts')).toContain("'voice'")
  })

  it('i18n 两 locale 都有 voiceInput 节（键集同形，防单侧漂移）', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    const zhKeys = [...zh.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1])
    expect(zh).toContain('voiceInput: {')
    expect(en).toContain('voiceInput: {')
    for (const key of [
      'micStart',
      'micStartTip',
      'micStop',
      'micStopTip',
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
