// ── 语音输入全链路接线扫描（PLAN-voice-input M1/M2/M3）──
// packed-node-modules 同款纪律：装配形状用源码扫描钉住（IO/渲染端行为由探针
// 与冒烟钉）。负扫：sherpa-onnx-* 绝不进 dependencies（P4——electron-builder
// 照单全收打进 asar，体积红线）。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

// ── 推理进程隔离（2026-11-24 Linux「点停止即闪退、零日志」事故的修法）──
// 事故形态只有一个解释：原生层 abort/SIGSEGV/OOM-kill 带走了整个应用。所以
// 承重结论是「推理必须离开主进程地址空间」，以及「子进程的每种死法都要留物证」。
// 这一组钉装配形状（行为由 tests/asr-host|port|recognizer 真跑，探针/冒烟见下）。
describe('推理进程隔离（2026-11-24 闪退事故）', () => {
  const recognizer = read('src/main/services/asr-recognizer.ts')
  const host = read('src/main/services/asr-host.ts')
  const worker = read('src/main/services/asr-worker.ts')
  const handler = read('src/main/ipc/asr.handler.ts')

  it('主进程只经 spawnAsrHost 起推理：不 dlopen addon、不自己建线程', () => {
    expect(recognizer).toContain('spawnAsrHost')
    // 负扫剥注释：文件头正解释「以前这里会 dlopen」，字面量本身不能当证据
    const code = recognizer
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    // loadAsrAddon 一旦回到主进程，一次 dlopen 崩溃就能再次带走整个应用
    expect(code).not.toContain('loadAsrAddon')
    expect(code).not.toContain('node:worker_threads')
    expect(code).not.toContain('new Worker(')
  })

  it('worker 走双宿主父端口，且绝不自杀（进程退出码是崩溃判据）', () => {
    expect(worker).toContain('openChildPort()')
    expect(worker).not.toContain('process.exit(')
    // 里程碑只走 stderr：utility 以 pipe 拉起，宿主按行收进 main.log
    expect(worker).toContain('process.stderr.write(')
  })

  it('utility 分支：asar 内 modulePath 可 fork、pipe、独立 serviceName、stdout 必须消费', () => {
    expect(host).toContain('utilityProcess.fork')
    expect(host).toContain("stdio: 'pipe'")
    expect(host).toContain('serviceName: ASR_SERVICE_NAME')
    expect(host).toContain('export const ASR_SERVICE_NAME')
    // 不消费 stdout：子进程写满 64KB 管道后卡死在 write 上
    expect(host).toContain('child.stdout?.on')
    // exit 先于管道读完是常态：定稿前必须排空，否则丢掉最后的崩溃现场
    expect(host).toMatch(/drainStderr\(child\.stderr/)
  })

  it('线程回落同样抓 stderr（纯 Node / 冒烟里才有现场）', () => {
    expect(host).toMatch(/new Worker\(o\.workerPath, \{ stdout: true, stderr: true \}\)/)
    expect(host).toMatch(/drainStderr\(worker\.stderr/)
  })

  it('崩溃可观测：child-process-gone 按 serviceName 过滤后落 main.log', () => {
    expect(handler).toContain("app.on?.('child-process-gone'")
    expect(handler).toContain('ASR_SERVICE_NAME')
    expect(handler).toContain('engine process gone: reason=')
  })

  it('用户看到的是可重试错误 + 日志路径，而不是应用消失', () => {
    expect(recognizer).toContain('应用本身未受影响')
    expect(recognizer).toContain('~/.pulsemind/logs/main.log')
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

describe('Linux 随包引擎：1.12.40 钉版（2026-11-23）', () => {
  const workflow = read('.github', 'workflows', 'build-linux.yml')
  const prepare = read('scripts', 'prepare-asr-engine.js')

  const lineNo = (text: string): number => {
    const i = workflow.split('\n').findIndex((line) => line.trim() === text)
    expect(i, `workflow 缺整行：${text}`).toBeGreaterThan(-1)
    return i
  }

  it('装 pin 版平台包在 npm ci 之后、生成引擎之前；引擎在 build 之前', () => {
    const npmCi = lineNo('npm ci')
    const pin = lineNo('run: npm i --no-save sherpa-onnx-linux-x64@1.12.40')
    const prep = lineNo('run: node scripts/prepare-asr-engine.js --platform-arch linux-x64')
    const build = lineNo('run: npm run build')
    expect(npmCi).toBeLessThan(pin)
    expect(pin).toBeLessThan(prep)
    expect(prep).toBeLessThan(build)
  })

  it('prepare 的 pin 与 CI 装的版本同一字面量；manifest 版本来自源平台包', () => {
    const pin = prepare.match(/'linux-x64':\s*'([0-9.]+)'/)?.[1]
    expect(pin).toBe('1.12.40')
    expect(workflow).toContain(`sherpa-onnx-linux-x64@${pin}`)
    // 版本必须读 node_modules/<平台包>/package.json —— sherpa-onnx-node 的 2.0.2
    // 会让 Linux 写假版本，打包后 sha/版本门与目录名对不上
    expect(prepare).toContain('function sourceVersion(pkgDir)')
    expect(prepare).toMatch(/join\(REPO, 'node_modules', pkgDir, 'package\.json'\)/)
    expect(prepare).toContain('JSON.stringify({ version, platformArch, files }')
    // 负扫：读 meta 包的旧常量不许长回来
    expect(prepare).not.toContain('const VERSION =')
  })

  it('打包态落地硬门：四个二进制 + manifest 且版本 = 1.12.40', () => {
    // 应用侧缺引擎是静默降级不是崩 —— 没有别的地方会红
    expect(workflow).toContain('- name: Verify bundled ASR engine landed')
    for (const f of ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'manifest.json']) {
      expect(workflow).toContain(f)
    }
    expect(workflow).toMatch(/m\.version !== "1\.12\.40"/)
  })

  it('真转写冒烟走产品加载器与打包产物（模型缺席只降级为 engine-load）', () => {
    expect(workflow).toContain('- name: Smoke packed ASR runtime')
    expect(workflow).toContain('node scripts/smoke-packed-asr.js --app-out dist/linux-unpacked --platform linux --arch x64 $model_args')
    // 与 mac/win 共用同一份 SenseVoice 缓存（同一模型包通吃两代引擎）
    expect(workflow).toContain('asr-sensevoice-2024-07-17')
  })
})

// ── mac 两架构：平台包必须显式补装（2026-11-23 实锤）──
// lockfile 是在 arm64 开发机上生成的，平台包只有 darwin-arm64 一格；`npm ci`
// 只装 lockfile 里有的东西，于是真 Intel runner（以及任何 lockfile 形态与宿主
// 不符的 runner）上 prepare-asr-engine 直接以「不在 node_modules」退出。Linux
// 段早有显式补装，这两份缺 —— 钉「npm ci → 补装 → prepare → build」的整行顺序。
describe('macOS CI：darwin 平台包显式补装（不依赖 lockfile 的宿主形态）', () => {
  for (const wf of ['build-mac-x64.yml', 'build-mac-arm64.yml']) {
    it(`${wf} 在 prepare 之前装 sherpa-onnx-darwin-$ARCH（版本跟随宿主包）`, () => {
      const src = read('.github', 'workflows', wf)
      const lines = src.split('\n').map((l) => l.trim())
      const idx = (needle: string): number => {
        const i = lines.findIndex((l) => l === needle)
        expect(i, `${wf} 缺整行：${needle}`).toBeGreaterThan(-1)
        return i
      }
      const npmCi = idx('run: npm ci')
      const install = idx('npm i --no-save "sherpa-onnx-darwin-$ARCH@$ver"')
      const ver = idx('ver=$(node -p "require(\'sherpa-onnx-node/package.json\').version")')
      const prep = idx('run: node scripts/prepare-asr-engine.js')
      const build = idx('run: npm run build')
      expect(npmCi).toBeLessThan(ver)
      expect(ver).toBeLessThan(install)
      expect(install).toBeLessThan(prep)
      expect(prep).toBeLessThan(build)
      // 负扫：不许退回「npm ci 天然装对平台包」的假设（那句注释曾掩盖此坑）
      expect(src).not.toContain('npm ci 的 optionalDependencies 天然装')
    })
  }
})

// ── 方案 ①：随包私有 C++ 运行库（2026-11-23 裁定）──
// 引擎要 GLIBCXX_3.4.29，UOS 20 的系统 libstdc++ 只到 3.4.25。同名塞一份没用
//（glibc 按 SONAME 复用已加载对象），所以改名 libpmcxx.so.6 并改引擎的 NEEDED。
// 这一组钉「三处名字必须同一个字面量」：prepare 的常量、blob 的实际 sha、以及
// 落地门禁与冒烟里出现的文件名。任何一处漂了，装机才报 version not found。
describe('私有 C++ 运行库 libpmcxx.so.6（方案 ①）', () => {
  const prepare = read('scripts', 'prepare-asr-engine.js')
  const engineSrc = read('src', 'main', 'services', 'asr-engine.ts')
  const smoke = read('scripts', 'smoke-packed-asr.js')
  const workflow = read('.github', 'workflows', 'build-linux.yml')
  const BLOB = join(REPO, 'resources', 'cxx-runtime', 'linux-x64', 'libpmcxx.so.6')

  it('blob 是提交物（能被 git 收），且有 README 记来源/许可/制作步骤', () => {
    // 与 resources/asr-engine（脚本产出、gitignore）纪律相反：它必须先存在，
    // prepare 才能校验 sha 再拷贝
    const ignore = read('.gitignore')
    expect(ignore).toContain('resources/asr-engine/')
    expect(ignore).toContain('!resources/cxx-runtime/**')
    expect(ignore).not.toMatch(/^resources\/cxx-runtime\/$/m)
    const readme = read('resources', 'cxx-runtime', 'README.md')
    expect(readme).toContain('GCC Runtime Library Exception')
    expect(readme).toContain('85964cabf42087d9145a99e3c45b904f0e2760002f8d4b1dc73d8382f122cc09')
    expect(readme).toContain('_dl_lookup_map')
  })

  it('prepare 钉的 sha256 就是仓库里那份 blob（换了 blob 不同步 → prepare 当场失败）', () => {
    const pinned = prepare.match(/sha256:\s*'([0-9a-f]{64})'/)?.[1]
    expect(pinned, 'prepare 里没有 sha256 钉子').toMatch(/^[0-9a-f]{64}$/)
    const actual = createHash('sha256').update(readFileSync(BLOB)).digest('hex')
    expect(actual, 'blob 与 prepare 里的钉子不一致——要么改了 blob，要么改了钉子').toBe(pinned)
    expect(prepare).toContain("name: 'libpmcxx.so.6'")
    expect(prepare).toContain("replaces: 'libstdc++.so.6'")
  })

  it('加载器：私有运行库只在 prepare 产出的目录（有 manifest）里要求', () => {
    // 塞进 REQUIRED_FILES 会让 Linux dev 回落（node_modules 里的厂商包，没有
    // 这个副本）永远报「引擎不完整」——这是负扫的意义
    expect(engineSrc).toMatch(/linux: \['sherpa-onnx\.node', 'libonnxruntime\.so', 'libsherpa-onnx-c-api\.so', 'libsherpa-onnx-cxx-api\.so'\]/)
    expect(engineSrc).toMatch(/PRIVATE_RUNTIME[\s\S]{0,120}libpmcxx\.so\.6/)
    expect(engineSrc).toContain("existsSync(join(dir, 'manifest.json'))")
    expect(engineSrc).toContain('privateRuntimeFiles(c.dir)')
  })

  it('冒烟与落地门禁都认这个名字（打包产物里缺了/没改名都要红）', () => {
    expect(smoke).toMatch(/linux: \[[^\]]*'libpmcxx\.so\.6'\]/)
    expect(smoke).toContain("libstdc++.so.6\\0")
    expect(workflow).toContain('libpmcxx.so.6 manifest.json')
    expect(workflow).toContain('m.files["libpmcxx.so.6"]')
  })

  it('门禁脚本对同一字面量做提供方识别（不是硬编码 3.4.30）', () => {
    const gate = read('scripts', 'check-linux-glibc.js')
    expect(gate).toContain("PRIVATE_CXX_NAME = 'libpmcxx.so.6'")
    expect(gate).toContain('function providerCapabilities')
    // 上限必须来自实测（formatVersion(provider.cxxProvides)），不能写死数字
    expect(gate).toContain('formatVersion(row.provider.cxxProvides)')
    expect(gate).not.toContain("= '3.4.30'")
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

  it('录音态按钮 = 停止方块 + 实时波形（user 2026-11-23：波形读不出「可点停」）', () => {
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    // 方块在 recording 分支里，与波形并排：一个表达「再点一次就停」，一个表达「在收音」
    expect(input).toContain('pm-voice-stop-square')
    expect(input).toMatch(/pm-voice-stop-square[\s\S]{0,400}<VoiceWaveform levelRef=\{voice\.state\.levelRef\}/)
    // 方块用 currentColor 跟随按钮的红色信号色；尺寸字面固定，录音期间不抖
    expect(input).toMatch(/pm-voice-stop-square[\s\S]{0,200}background: 'currentColor'/)
    expect(input).toMatch(/pm-voice-stop-square[\s\S]{0,200}width: 10, height: 10/)
    // 波形本身不进 state、尺寸固定：电平走 ref 由 canvas 自己读
    const wave = read('src/renderer/src/components/chat/VoiceWaveform.tsx')
    expect(wave).toContain('levelRef.current')
    expect(wave).toContain('requestAnimationFrame')
    expect(wave).not.toContain('useState')
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
    expect(input).toContain("if (e.key !== 'Escape') return")
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
    // 锚点来源必须是「点麦克风那一刻」的坐标（pointerdown 抓，先于 blur）。
    // 直接读失焦后的 selectionStart 会拿到 0，整段语音被塞到最前面
    // （user 2026-11-23 反馈「分段向前追加」）。
    expect(input).toContain('voiceCaretRef')
    expect(input).toContain('onPointerDown=')
    expect(input).toContain('document.activeElement === ta')
    // 没焦点 → null → 落到末尾，而不是 0
    expect(input).toContain('at === null ? len : Math.min(at, len)')
    // 快捷键（⌥V）路径不走 pointerdown，但焦点就在 textarea 上，也得记一次
    const hotkeyFrom = input.indexOf("e.code !== 'KeyV'")
    expect(input.slice(hotkeyFrom, hotkeyFrom + 700)).toContain('voiceCaretRef.current =')
    // 锚点必须每段往前推。它是我们记的落点、不是 DOM 选区，不推进就会每段插在
    // 同一处，后说的排到前面——整段语音倒序（user 2026-11-23 反馈
    // 「AAAAAA 第三段 第二段 第一段 AAAAAA」）。这条是本轮补的：上一版断言只验了
    // 「不读实时选区」，没验「要往前推」，倒序就从缝里漏了过去。
    expect(insertBody).toContain('voiceAnchorRef.current = caret')
    // 插入后不许抢焦点（会把焦点从麦克风按钮夺走），也不许覆盖用户已有选区
    // ——听写中选中文字是为了复制。
    expect(insertBody).not.toContain('.focus()')
    expect(insertBody).toContain('el.selectionStart !== el.selectionEnd')
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
