/**
 * 生成 resources/asr-engine/<platform>-<arch>/（PLAN-voice-input §3.2，CI/dev 共用）。
 *
 * 引擎随包纪律：每个安装包只背本平台本架构的 sherpa-onnx 引擎（~30MB 压缩），
 * 模型才是动态件。产出带 manifest.json（版本 + 逐文件 sha256），主进程加载器
 * （asr-engine.ts）据此跑 sha 门。
 *
 * 用法：node scripts/prepare-asr-engine.js [--platform-arch darwin-arm64]
 *   缺省处理当前平台架构；跨架构打包（arm64 宿主出 x64 dmg）传参前先
 *   `npm i --no-save sherpa-onnx-<pkg-platform>-<arch>@<version>` 装齐目标平台的
 *   devDep 包。⚠️ npm 包名段与目录名不同：厂商 Windows 包叫 win（sherpa-onnx-win-x64），
 *   目录/resources 布局仍用 process.platform 的 win32（打包 filter 是 win32-${arch}/**）。
 *
 * 平台后处理（M0 实测结论，2026-11-19）：
 * - mac：官方包已自带 LC_RPATH=@loader_path（M0-4 独立目录免 DYLD_* 可载），
 *   无需 install_name_tool；ad-hoc 重签一次保证拷贝后签名一致（CI 有正式身份
 *   则在 CI 步骤里替换 --sign -）。
 * - linux：需要 patchelf --set-rpath '$ORIGIN'。⚠️ M0-3 静态扫描：官方 linux
 *   包的 sherpa-onnx.node 需要 GLIBC_2.32（__libc_single_threaded）+ GLIBCXX_3.4.26，
 *   双双超 UOS 20 的 2.28 上限——**官方 .so 不能直接随包发 linux**，必须 zig
 *   从源码自编（better-sqlite3 的 zig-cc 通道现成，target 钉 2.28，libc++ 静态
 *   链接顺带消掉 GLIBCXX 依赖）。自编产物落进本目录后本脚本只补 manifest。
 *   本脚本在缺 patchelf/自编产物时对 linux 报 warning 不报错（deb CI 的门禁
 *   check-linux-glibc.js 会在打包时拦下超限产物）。
 * - win：零处理——process.dlopen 用 LOAD_WITH_ALTERED_SEARCH_PATH，同目录 dll
 *   可解析（M0 实机待验，win 包已 grep 验证 0 DirectML 引用，OCR v1 死因
 *   结构性避开）。
 */

const { createHash } = require('node:crypto')
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const REPO = join(__dirname, '..')
const DEST_ROOT = join(REPO, 'resources', 'asr-engine')
const VERSION = require(join(REPO, 'node_modules', 'sherpa-onnx-node', 'package.json')).version

const REQUIRED = {
  darwin: ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib'],
  win32: ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll'],
  linux: ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so'],
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', ...opts }).toString()
  } catch (e) {
    return null
  }
}

function prepare(platformArch) {
  const [platform, ...archParts] = platformArch.split('-')
  // npm 包名段：win32 → win（厂商平台包命名），目录名保持 platformArch 原样
  const pkgDir = `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${archParts.join('-')}`
  const src = join(REPO, 'node_modules', pkgDir)
  const required = REQUIRED[platform] ?? REQUIRED.linux
  if (!existsSync(src)) {
    console.error(`✗ ${pkgDir} 不在 node_modules —— 先 npm i --no-save ${pkgDir}@${VERSION}`)
    process.exit(1)
  }
  if (!required.every((f) => existsSync(join(src, f)))) {
    console.error(`✗ ${platformArch} 包缺必备文件（需要 ${required.join(' + ')}）`)
    process.exit(1)
  }

  const dest = join(DEST_ROOT, platformArch)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const f of required) cpSync(join(src, f), join(dest, f))

  // mac：签名一致性（文件未改，但换目录后 ad-hoc 重签最便宜且确定）
  if (platform === 'darwin') {
    const hasRpath = (run('otool', ['-l', join(dest, 'sherpa-onnx.node')]) ?? '').includes('@loader_path')
    if (!hasRpath) {
      console.error(`✗ ${platformArch}/sherpa-onnx.node 缺 @loader_path rpath —— dylib 将无法解析（M0-4 门红）`)
      process.exit(1)
    }
    for (const f of required) run('codesign', ['--force', '--sign', '-', join(dest, f)])
  }

  // linux：rpath 烘焙（官方 .node 超 GLIBC_2.28 时由 zig 自编替代——见文件头）
  if (platform === 'linux') {
    const patched = run('patchelf', ['--set-rpath', '$ORIGIN', join(dest, 'sherpa-onnx.node')])
    if (!patched) {
      console.warn(
        `⚠ patchelf 不可用或失败：${platformArch}/sherpa-onnx.node 的 rpath 未烘焙。` + '若这是 zig 自编产物（已烘焙 $ORIGIN）可忽略；官方包请装 patchelf。',
      )
    }
  }

  // manifest：版本 + 逐文件 sha256（主进程加载器的 sha 门数据源）
  const files = {}
  for (const f of required) {
    files[f] = createHash('sha256')
      .update(readFileSync(join(dest, f)))
      .digest('hex')
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ version: VERSION, platformArch, files }, null, 2), 'utf8')
  const total = required.reduce((a, f) => a + statSync(join(dest, f)).size, 0)
  console.log(`✓ asr-engine ${platformArch} 就绪（${(total / 1048576).toFixed(1)}MB, ${required.length} files, sha manifest 写入）`)
}

function main() {
  const idx = process.argv.indexOf('--platform-arch')
  const targets = idx >= 0 ? process.argv[idx + 1].split(',') : [`${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`]
  rmSync(DEST_ROOT, { recursive: true, force: true })
  mkdirSync(DEST_ROOT, { recursive: true })
  for (const t of targets) prepare(t)
}

main()
