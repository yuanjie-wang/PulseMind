'use strict'

// afterPack：裁掉随包 Chromium / Electron 的语言资源，以及 Windows 上永不加载的
// 桌面集成件。带一个自检模式（--verify），CI 在打包后用它证明「这一刀真的落下去了」。
//
// 为什么现在做（2026-11-24 实测，0.5.2 的 win-unpacked 921MB / mac .app 712MB）：
// Chrome 153 把 locale 包从 55 个扩成 220 个（新增 af_FEMININE / af_MASCULINE /
// af_NEUTER 这类带性别的变体），单个 0.19–1.7MB：
//   Chromium locales   win 42MB → 约 2.0MB   mac 48MB → 约 1.7MB
//   Electron locales   win 40MB → 约 1.4MB   mac 0B（55 个 .lproj 全是空文件，
//                                              Electron Framework 那份已由
//                                              strip-lproj 处理）
// 再加 Windows 的桌面集成件 23.1MB：win 侧实测一次裁掉 100.2MB。
//
// 语言资源为什么可以删：app 界面文字走 React i18n（只有 zh/en 两套 locale），
// Chromium 与 Electron 自带的 .pak/.lproj 只决定**原生**文案（右键菜单、崩溃
// 对话框、浏览器自身的设置页）。缺包时 Chromium 的 ResourceBundle 回落 en-US。
// 保留 en / zh 变体是为了「系统语言是中文时原生菜单也是中文」这条体验。
//
// Windows 桌面集成件为什么可以删：它们全是「把 Chrome 装成系统默认浏览器 / 注册
// 通知与快捷方式」用的，而 ManagedBackend 直接 exec chrome.exe（headless 默认）。
// 显式不删的邻近项各有理由，别顺手加进来：
//   chrome_elf.dll        chrome.exe 启动即加载
//   D3DCompiler_47.dll    ANGLE/D3D11 的 HLSL 编译
//   vk_swiftshader.dll    headless 的 Vulkan 软渲染兜底
//   dxcompiler.dll/dxil   WebGPU/D3D12 着色器编译（26MB，中风险，留给产品决策）
//
// 时序：afterPack 在打包后、签名前跑 —— mac 的 ad-hoc 签名（CI 的 Ad-hoc sign
// the app 一步）因此签的是裁完的树。别把本步挪到签名之后。
//
// 纯机械操作；目标目录不存在时静默跳过（例如没装 Chromium 的构建机）。

const { readdirSync, rmSync, statSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

// 归一化后的保留名单（小写、- → _、性别后缀已剥离）。
const KEEP_LOCALES = new Set(['en', 'en_us', 'en_gb', 'zh', 'zh_cn', 'zh_tw', 'zh_hk'])

// Chrome 153 的 af_FEMININE.pak / de_MASCULINE.pak 之类：同一语言的表情/语法
// 性别变体，只被实验性界面措辞用到。剥掉后缀是为了让它们归到**基础语言**判定
// ——de_FEMININE 随 de 一起删，en-US_MASCULINE 随 en_us 一起留（英文那几份
// 合计不到 1MB，为它们另立一条规则不值）。
const GENDER_SUFFIX = /_(feminine|masculine|neuter)$/i

// Windows Chromium 根目录下「装进系统」才用到的文件（2026-11-24 实测合计 23.1MB）。
const WIN_DESKTOP_EXTRAS = [
  'setup.exe', // 6.1MB  安装器
  'elevated_tracing_service.exe', // 4.5MB  提权后的性能跟踪服务
  'elevation_service.exe', // 3.8MB  提权服务
  'chrome_pwa_launcher.exe', // 3.2MB  已安装 PWA 的启动器
  'notification_helper.exe', // 2.8MB  系统通知集成
  'chrome_proxy.exe', // 2.6MB  快捷方式代理启动器
  'chrome_wer.dll', // 0.1MB  崩溃上报（delay-load）
  'MEIPreload', // Windows 提权的预加载清单
]

// 遍历时不下探的目录名：这些不是语言资源，深挖只会浪费时间。
const SKIP_DIRS = new Set(['First Run', 'IwaKeyDistribution', 'PrivacySandboxAttestationsPreloaded'])

function localeKey(name) {
  return name.replace(/\.(pak|lproj)$/i, '').replace(GENDER_SUFFIX, '').replace(/-/g, '_').toLowerCase()
}

function dirSize(path) {
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      total += statSync(join(path, entry.name)).size
    } catch {
      /* 文件在遍历期间消失（并发构建）——忽略 */
    }
  }
  return total
}

function tally(acc, count, bytes, sample) {
  acc.count += count
  acc.bytes += bytes
  if (sample && acc.samples.length < 8) acc.samples.push(sample)
  return count
}

// <dir>/*.pak 里删掉（或仅统计）不在保留名单的文件。
function prunePakDir(dir, apply, acc) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.pak')) continue
    if (KEEP_LOCALES.has(localeKey(entry.name))) continue
    const full = join(dir, entry.name)
    try {
      const size = statSync(full).size
      if (apply) rmSync(full, { force: true })
      tally(acc, 1, size, full)
    } catch {
      /* 同上 */
    }
  }
}

// mac：语言资源是 <lang>.lproj 目录（每个里面是同一个 Localizable.strings）。
// 名字与 win 的 pak 不同（zh_CN vs zh-CN），localeKey 已把两者归一。
function pruneLprojDir(dir, name, apply, acc) {
  if (KEEP_LOCALES.has(localeKey(name))) return
  const bytes = dirSize(dir)
  tally(acc, 1, bytes, dir)
  if (!apply) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

// 在 root 下找所有 `locales` 目录与 `<lang>.lproj` 目录。目录条目上的
// isDirectory() 对符号链接返回 false —— Chromium mac 包的 Versions/Current
// 是指向版本号的相对链接，于是这里天然不会从 Current 下重复走一遍，也不会
// 顺着链接走出打包树。
function walkLocales(root, depth, apply, acc) {
  if (depth > 12) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.name === 'locales') {
      prunePakDir(full, apply, acc)
      continue
    }
    if (entry.name.endsWith('.lproj')) {
      pruneLprojDir(full, entry.name, apply, acc)
      continue
    }
    walkLocales(full, depth + 1, apply, acc)
  }
}

function pruneWinDesktopExtras(chromiumDir, apply, acc) {
  let flavors
  try {
    flavors = readdirSync(chromiumDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const flavor of flavors) {
    if (!flavor.isDirectory() || !flavor.name.startsWith('chrome-win')) continue
    for (const name of WIN_DESKTOP_EXTRAS) {
      const full = join(chromiumDir, flavor.name, name)
      if (!existsSync(full)) continue
      let size = 0
      try {
        const st = statSync(full)
        size = st.isDirectory() ? dirSize(full) : st.size
        if (apply) rmSync(full, { recursive: true, force: true })
        tally(acc, 1, size, full)
      } catch {
        /* 忽略 */
      }
    }
  }
}

// darwin: <appOutDir>/<Product>.app/Contents/{Resources,MacOS}
// win32/linux: <appOutDir>/{resources,locales}
function layoutOf(context) {
  const darwin = context.electronPlatformName === 'darwin'
  const contentsDir = darwin
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir
  return {
    darwin,
    resourcesDir: join(contentsDir, darwin ? 'Resources' : 'resources'),
    electronLocalesDir: join(context.appOutDir, 'locales'),
  }
}

// apply=false 时只统计「还该删什么」，一份不删。
function scan(context, apply) {
  const { darwin, resourcesDir, electronLocalesDir } = layoutOf(context)
  const acc = { count: 0, bytes: 0, samples: [] }
  const chromiumDir = join(resourcesDir, 'chromium')
  if (existsSync(chromiumDir)) walkLocales(chromiumDir, 0, apply, acc)
  // Electron 自己的 locales（win/linux 在 app 根；darwin 的 .lproj 在
  // Electron Framework.framework/Resources 下，已由 strip-lproj 处理且都是
  // 0 字节，这里不重复走）。
  if (!darwin) prunePakDir(electronLocalesDir, apply, acc)
  if (context.electronPlatformName === 'win32') pruneWinDesktopExtras(chromiumDir, apply, acc)
  return acc
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}

exports.default = async function prunePackagedAssets (context) {
  const acc = scan(context, true)
  if (acc.count > 0) {
    console.log(`[prune-assets] Removed ${acc.count} unused locale/desktop-integration entries (${mb(acc.bytes)}MB), kept en/zh`)
  }
}

exports.scan = scan

// ── 自检模式 ──
// 用法：node scripts/prune-packaged-assets.js --verify --app-out <dir> --platform <darwin|win32|linux>
// 判据 = dry run 报零 + 每个 locales 目录仍留着一份 en/zh（后者防「保留名单
// 归一写坏了，把整个 locales 删空」）。名字改了导致某类文件不再被删时不判红
// ——那是收益缩水，不是包坏；这一类由 CI 的打包体积报告看趋势。
exports.verify = function verify (context) {
  const errors = []
  const acc = scan(context, false)
  if (acc.count > 0) {
    errors.push(`${acc.count} prunable entries left (${mb(acc.bytes)}MB); first: ${acc.samples.join(', ')}`)
  }
  const { darwin, resourcesDir, electronLocalesDir } = layoutOf(context)
  const chromiumDir = join(resourcesDir, 'chromium')
  const dirs = []
  if (existsSync(chromiumDir)) collectLocaleDirs(chromiumDir, 0, dirs)
  if (!darwin) dirs.push(electronLocalesDir)
  for (const dir of dirs) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue // 目录本就不存在（没打 Chromium 的构建）——由别的门禁负责
    }
    const kept = entries.filter((n) => /\.(pak|lproj)$/i.test(n) && /^(en|zh)/i.test(n))
    if (kept.length === 0) {
      errors.push(`${dir}: no en/zh locale survived — keep list regressed`)
    }
  }
  return errors
}

function collectLocaleDirs(root, depth, out) {
  if (depth > 12) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.name === 'locales') {
      out.push(full)
      continue
    }
    if (entry.name.endsWith('.lproj')) continue // 语言目录本身不是容器
    collectLocaleDirs(full, depth + 1, out)
  }
}

exports.KEEP_LOCALES = KEEP_LOCALES
exports.WIN_DESKTOP_EXTRAS = WIN_DESKTOP_EXTRAS
exports.localeKey = localeKey

if (require.main === module) {
  const argv = process.argv.slice(2)
  const argOf = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const appOut = resolve(argOf('app-out') || '')
  const platform = argOf('platform')
  if (!argv.includes('--verify') || !appOut || !platform) {
    console.error('usage: prune-packaged-assets.js --verify --app-out <dir> --platform <darwin|win32|linux>')
    process.exit(2)
  }
  const errors = exports.verify({
    appOutDir: appOut,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: argOf('product') || 'PulseMind' } },
  })
  if (errors.length > 0) {
    for (const e of errors) console.error(`[prune-assets] VERIFY FAIL: ${e}`)
    process.exit(1)
  }
  console.log(`[prune-assets] verify OK (${platform}): nothing left to prune, en/zh preserved`)
}