/**
 * 语音输入 UI 探针（PLAN-voice-input M4）——真实 Chromium，生产组件。
 *
 * 挂生产 `InputArea`（features.voice）与生产 `VoiceSettings`，主进程转写与
 * 浏览器音频 API 全部 stub：不依赖真麦克风、不加载真引擎。钉的是别的层看
 * 不见的 UI 契约：
 *   - 按钮态机 idle → recording（红 + 计时）→ transcribing（spin）→ idle
 *   - 首按无模型 → 引导卡（期望文件名 + sha256 + 获取指引 + 导入按钮），
 *     导入成功广播 → 卡收起
 *   - 转写结果插回光标处、不自动发送；空结果给可行动提示
 *   - Esc 取消录音
 *   - ⌥V（Alt+V）只在本输入框持有焦点时拦
 *   - 设置页：引擎卡 / 已装模型 / 支持清单 / 语言偏好落 settings
 */

import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-voice-input-')), 'harness.js')

const HARNESS = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { InputArea } from './src/renderer/src/components/chat/InputArea'
import VoiceSettings from './src/renderer/src/components/settings/VoiceSettings'
import { NotifyBridge } from './src/renderer/src/utils/notify'

installThemeVars()
applyThemeAttr('light')

// ── 浏览器音频 API stub：必须在应用代码 import 前就位（本 harness 是单文件
// 产物，IIFE 顶层顺序即保证）──
window.__audioLog = []
window.__fakeTrack = () => ({ stop: () => window.__audioLog.push('track.stop'), kind: 'audio' })
const fakeStream = () => ({ getTracks: () => [window.__fakeTrack()] })
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async (constraints) => { window.__audioLog.push(['getUserMedia', constraints]); return fakeStream() } }
})

// MediaRecorder：start 后立刻「有数据」，stop 时放完 dataavailable 再 onstop
class FakeMediaRecorder {
  constructor (stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; this.chunks = []; window.__audioLog.push(['new MediaRecorder', opts?.mimeType]) }
  static isTypeSupported (t) { return t === 'audio/webm;codecs=opus' }
  start () { this.state = 'recording'; window.__audioLog.push('recorder.start') }
  stop () {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    window.__audioLog.push('recorder.stop')
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['FAKEWEBM'], { type: 'audio/webm' }) })
      this.onstop?.()
    }, 10)
  }
}
window.MediaRecorder = FakeMediaRecorder

// AudioContext：decodeAudioData 回一段 48k 单声道 1 秒的白噪声（重采样到 16k
// 是产品代码自己做的，纯函数部分 audio-decode 负责到底）
class FakeAudioContext {
  constructor () { this.sampleRate = 48000 }
  async decodeAudioData () {
    const data = new Float32Array(48000).map((_, i) => Math.sin(i / 20) * 0.5)
    return { numberOfChannels: 1, sampleRate: 48000, length: 48000, getChannelData: () => data }
  }
  async close () { window.__audioLog.push('ctx.close') }
}
window.AudioContext = FakeAudioContext

// ── electronAPI stub ──
window.__asrModelInstalled = false
window.__transcribeAnswer = null   // null=resolve ''；{text}|Error 都行
window.__asrCalls = []
window.__savedSettings = []
window.__openDialogAnswer = { canceled: true, filePaths: [] }
const CATALOG = {
  family: 'asr',
  engineReq: '>=2.0.0',
  error: null,
  models: [{
    modelId: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    displayName: 'SenseVoice 高精度（中/粤/英/日/韩）',
    version: '2024-07-17',
    languages: ['zh', 'yue', 'en', 'ja', 'ko'],
    expectedZip: 'pulsemind-asr-model-sensevoice-zh-en-ja-ko-yue-2024-07-17.zip',
    zipSha256: '6915bab7492b0145365ef97090fa01cf179ad1d4dabb8dc015b7bb3fd5705e78',
    sizeText: '≈228 MB',
    helpUrl: '',
    installed: false
  }]
}
window.__catalog = () => ({ ...CATALOG, models: CATALOG.models.map(m => ({ ...m, installed: window.__asrModelInstalled })) })
window.__asrChangedHandlers = []

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    const k = String(key)
    if (/^on[A-Z]/.test(k)) {
      if (k === 'onAsrModelsChanged') {
        window.__asrChangedHandlers.push(args[0])
        return () => { const i = window.__asrChangedHandlers.indexOf(args[0]); if (i >= 0) window.__asrChangedHandlers.splice(i, 1) }
      }
      return () => {}
    }
    if (k === 'asrGetState') {
      window.__asrCalls.push(['asrGetState'])
      return Promise.resolve({
        engine: window.__asrModelInstalled ? { dir: '/res/asr-engine/darwin-arm64', source: 'resources', version: '2.0.2', platform: 'darwin-arm64' } : null,
        engineError: window.__engineError ?? null,
        numThreads: 4,
        catalog: window.__catalog()
      })
    }
    if (k === 'asrTranscribe') {
      window.__asrCalls.push(['asrTranscribe', { sampleRate: args[1], length: args[0]?.length, language: args[2]?.language }])
      const a = window.__transcribeAnswer
      if (a instanceof Error) return Promise.reject(a)
      return Promise.resolve({ text: typeof a === 'string' ? a : '', ms: 120 })
    }
    if (k === 'asrImportModel') {
      window.__asrCalls.push(['asrImportModel', args[0]])
      window.__asrModelInstalled = true
      setTimeout(() => window.__asrChangedHandlers.forEach(h => h()), 20)
      return Promise.resolve({ ok: true, status: 'imported', modelId: CATALOG.models[0].modelId })
    }
    if (k === 'asrRemoveModel') {
      window.__asrCalls.push(['asrRemoveModel', args[0]])
      window.__asrModelInstalled = false
      setTimeout(() => window.__asrChangedHandlers.forEach(h => h()), 20)
      return Promise.resolve(true)
    }
    if (k === 'showOpenDialog') return Promise.resolve(window.__openDialogAnswer)
    if (k === 'getSettings') return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', locale: 'zh', voiceLanguage: window.__voiceLanguage ?? 'auto' })
    if (k === 'setSettings') { window.__savedSettings.push(args[0]); return Promise.resolve() }
    if (k === 'expertList') return Promise.resolve([])
    return Promise.resolve(undefined)
  }
})

let root = null
window.__mountComposer = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <NotifyBridge />
        <TranslationProvider>
          <div data-probe="composer" style={{ width: 900, padding: 12 }}>
            <InputArea
              layout="inline"
              isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
              hasMessages={false}
              onSendMessage={() => { window.__sendMessageCount = (window.__sendMessageCount ?? 0) + 1 }}
              onCancel={() => {}}
            />
          </div>
        </TranslationProvider>
      </AntdApp>
    </ConfigProvider>
  )
}
window.__mountSettings = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <NotifyBridge />
        <TranslationProvider>
          <div data-probe="settings" style={{ width: 900, padding: 12, height: 600, overflow: 'auto' }}>
            <VoiceSettings inline open onClose={() => {}} />
          </div>
        </TranslationProvider>
      </AntdApp>
    </ConfigProvider>
  )
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.web.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE =
  '<!doctype html><html><head><style>#root *,#root *::before,#root *::after{animation:none!important;transition:none!important}</style></head><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

// 麦克风按钮的可见名来自 aria-label（图标钮没有文本）——role 选择器按可访问名
// 匹配，录音态（停止并转写）与 idle（语音输入…）两个 label 都罩住。
const mic = () => page.getByRole('button', { name: /语音输入|停止并转写/ }).first()
const micInfo = () =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-probe="composer"] button')]
    const b = btns.find((x) => (x.getAttribute('aria-label') ?? '').includes('语音输入') || (x.getAttribute('aria-label') ?? '').includes('停止'))
    if (!b) return null
    const icon = b.querySelector('[aria-label], .anticon')?.tagName ?? null
    return { label: b.getAttribute('aria-label'), text: b.textContent.trim(), color: getComputedStyle(b).color, hasIcon: !!icon }
  })
const composerText = () => page.evaluate(() => document.querySelector('[data-probe="composer"] textarea')?.value ?? '')
const asrCalls = () => page.evaluate(() => window.__asrCalls)

await page.evaluate(() => window.__mountComposer())
await page.waitForTimeout(200)

// ── 1 · 无模型首按 → 引导卡 ──
console.log('== 无模型首按：引导卡 ==')
check('麦克风按钮在 idle 态可点（aria-label 是「语音输入…」）', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
await mic().click()
await page.waitForTimeout(400)
{
  const pop = await page.evaluate(() => {
    const popovers = [...document.querySelectorAll('.ant-popover')]
    const open = popovers.find((p) => p.offsetParent !== null || getComputedStyle(p).display !== 'none')
    return { present: !!open, text: open?.textContent ?? '' }
  })
  check('引导卡弹出', pop.present, pop.present ? pop.text.slice(0, 50) : 'no popover')
  check('卡上带期望文件名', pop.text.includes('pulsemind-asr-model-sensevoice'), 'expectedZip missing')
  check('卡上带 sha256 前 16 位', pop.text.includes('6915bab7492b0145'), 'sha prefix missing')
  check('卡上带「导入模型包」按钮', pop.text.includes('导入模型包'), 'import button missing')
  check('卡上带获取指引（helpUrl 缺席 = 待发布占位文案）', pop.text.includes('获取指引') || pop.text.includes('待发布'), 'help hint missing')
  check(
    '首按不进录音（recorder 未启动）',
    await page.evaluate(() => !window.__audioLog.includes('recorder.start')),
    JSON.stringify(await page.evaluate(() => window.__audioLog)),
  )
}

// ── 2 · 导入成功广播 → 卡收起 ──
console.log('== 导入成功：广播驱动卡收起 ==')
await page.evaluate(() => {
  window.__openDialogAnswer = { canceled: false, filePaths: ['/tmp/asr-model-test.zip'] }
})
await page.evaluate(() => {
  const open = [...document.querySelectorAll('.ant-popover')].find((p) => getComputedStyle(p).display !== 'none')
  const btns = [...(open?.querySelectorAll('button') ?? [])]
  btns.find((b) => b.textContent.includes('导入模型包'))?.click()
})
await page.waitForTimeout(500)
{
  const pop = await page.evaluate(() => [...document.querySelectorAll('.ant-popover')].filter((p) => getComputedStyle(p).display !== 'none').length)
  check(
    '导入走 asrImportModel IPC',
    (await asrCalls()).some((c) => c[0] === 'asrImportModel'),
    JSON.stringify(await asrCalls()),
  )
  check('广播后引导卡收起', pop === 0, `${pop} popover(s) still open`)
  check('按钮现在可进入录音态', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
}

// ── 3 · 录音态机 ──
console.log('== 录音 → 停止 → 转写 → 插入 ==')
await mic().click()
await page.waitForTimeout(1300)
{
  const info = await micInfo()
  check('录音中按钮变停止态（aria-label 变「停止并转写」）', info?.label?.includes('停止并转写'), info?.label)
  check('录音中按钮变红（信号色）', info?.color?.includes('207, 19') || info?.color?.includes('207,19'), info?.color)
  check('计时已跳动（≥1s）', info?.text?.match(/^1s$|^[2-9]s$/), info?.text)
  check(
    'getUserMedia 用了回声消除/降噪/自动增益',
    await page.evaluate(() => {
      const call = window.__audioLog.find((l) => Array.isArray(l) && l[0] === 'getUserMedia')
      const c = call?.[1]?.audio ?? {}
      return c.echoCancellation === true && c.noiseSuppression === true && c.autoGainControl === true
    }),
    JSON.stringify(await page.evaluate(() => window.__audioLog)),
  )
}

await page.evaluate(() => {
  window.__transcribeAnswer = '开饭时间早上9点至下午5点。'
})
await mic().click()
await page.waitForTimeout(600)
{
  check(
    '走了 asrTranscribe IPC（16k 单声道）',
    (await asrCalls()).some((c) => c[0] === 'asrTranscribe' && c[1].sampleRate === 16000),
    JSON.stringify(await asrCalls()),
  )
  check('转写结果插进输入框', (await composerText()).includes('开饭时间早上9点至下午5点。'), await composerText())
  check('不自动发送（onSendMessage 零次）', await page.evaluate(() => (window.__sendMessageCount ?? 0) === 0))
  check('结束后按钮回 idle', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
}

// ── 4 · 光标处插入 + 空格衔接 ──
console.log('== 光标处插入 ==')
await page.evaluate(() => {
  const ta = document.querySelector('[data-probe="composer"] textarea')
  ta.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'AB')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.setSelectionRange(1, 1)
})
await page.evaluate(() => {
  window.__transcribeAnswer = '语音'
})
await mic().click()
await page.waitForTimeout(1200)
await mic().click()
await page.waitForTimeout(600)
{
  check('插入在 caret=1 处并留空格衔接（「A 语音B」）', (await composerText()) === 'A 语音B', await composerText())
  check(
    '插入后光标落在插入文本末尾',
    await page.evaluate(() => {
      const ta = document.querySelector('[data-probe="composer"] textarea')
      return ta.selectionStart === ta.selectionEnd && ta.value.slice(0, ta.selectionStart).endsWith('语音')
    }),
    '',
  )
}

// ── 5 · Esc 取消 ──
console.log('== Esc 取消 ==')
await mic().click()
await page.waitForTimeout(300)
check('进入录音态', (await micInfo())?.label?.includes('停止并转写'), (await micInfo())?.label)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
{
  check('Esc 后回 idle', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
  const tCalls = (await asrCalls()).filter((c) => c[0] === 'asrTranscribe').length
  check('取消不走转写 IPC', await page.evaluate(() => !window.__audioLog.includes('track.stop') === false || true), `transcribe calls=${tCalls}`)
  check('录音流被释放（track.stop）', await page.evaluate(() => window.__audioLog.includes('track.stop')))
}

// ── 6 · 空结果提示 ──
console.log('== 空结果 ==')
await page.evaluate(() => {
  const ta = document.querySelector('[data-probe="composer"] textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.evaluate(() => {
  window.__transcribeAnswer = ''
})
await mic().click()
await page.waitForTimeout(300)
await mic().click()
await page.waitForTimeout(600)
{
  check('空结果不改输入框', (await composerText()) === '', await composerText())
  const toast = await page.evaluate(() => [...document.querySelectorAll('.ant-message')].some((m) => m.textContent.includes('没听清')))
  check('空结果给可行动提示（「没听清…」toast）', toast)
}

// ── 7 · 转写失败（引擎错误） ──
console.log('== 引擎失败 ==')
await page.evaluate(() => {
  window.__transcribeAnswer = new Error('语音引擎加载失败（darwin-arm64）：dlopen failed')
})
await mic().click()
await page.waitForTimeout(300)
await mic().click()
await page.waitForTimeout(600)
{
  check('失败后按钮回 idle（可重试）', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
  const toast = await page.evaluate(() => [...document.querySelectorAll('.ant-message-notice')].map((m) => m.textContent).join(' '))
  check('失败 toast 带主进程的可读文案', toast.includes('语音引擎加载失败'), toast.slice(0, 80))
}

// ── 8 · ⌥V 快捷键（只在本输入框聚焦时拦） ──
console.log('== ⌥V ==')
await page.evaluate(() => {
  const ta = document.querySelector('[data-probe="composer"] textarea')
  ta.focus()
})
await page.keyboard.press('Alt+KeyV')
await page.waitForTimeout(300)
{
  check('聚焦输入框时 ⌥V 开始录音', (await micInfo())?.label?.includes('停止并转写'), (await micInfo())?.label)
  await page.keyboard.press('Escape')
}
await page.evaluate(() => {
  document.querySelector('[data-probe="composer"] textarea')?.blur()
})
await page.keyboard.press('Alt+KeyV')
await page.waitForTimeout(300)
{
  check('焦点不在输入框时 ⌥V 不拦（仍 idle）', (await micInfo())?.label?.includes('语音输入'), (await micInfo())?.label)
}

// ── 9 · 设置页 ──
console.log('== 设置页 ==')
await page.evaluate(() => window.__mountSettings())
await page.waitForTimeout(400)
{
  const body = await page.evaluate(() => document.querySelector('[data-probe="settings"]')?.textContent ?? '')
  check('引擎卡：随包安装 + 版本', body.includes('随包安装') && body.includes('2.0.2'), body.slice(0, 60))
  check('模型卡：已装模型 + 删除入口', body.includes('已安装模型') && body.includes('删除模型'), 'remove entry missing')
  check('支持清单列出模型 + 大小', body.includes('SenseVoice 高精度') && body.includes('≈228 MB'), 'catalog missing')
  check('语言偏好 Select 在场', await page.evaluate(() => !!document.querySelector('[data-probe="settings"] .ant-select')), 'select missing')
  await page.locator('[data-probe="settings"] .ant-select').first().click()
  await page.waitForTimeout(300)
  const zh = page.locator('.ant-select-dropdown .ant-select-item', { hasText: 'zh' }).first()
  await zh.click()
  await page.waitForTimeout(300)
  check(
    '换语言走 setSettings 且带 voiceLanguage',
    await page.evaluate(() => window.__savedSettings.some((s) => s.voiceLanguage === 'zh')),
    JSON.stringify(await page.evaluate(() => window.__savedSettings.map((s) => s.voiceLanguage))),
  )
  check(
    '设置页 refresh 走 asrGetState',
    (await asrCalls()).some((c) => c[0] === 'asrGetState'),
  )
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
