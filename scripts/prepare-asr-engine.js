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
 * - linux：**钉 1.12.40**（PLATFORM_PINS，2026-11-23）。1.13+ 的 sherpa-onnx.node
 *   要 GLIBC_2.32（__libc_single_threaded）+ GLIBCXX_3.4.26，双双超 UOS 20 的
 *   2.28 上限；1.12.40 把 **glibc 那半边**降到 GLIBC_2.16，且 RUNPATH 已烘焙
 *   `$ORIGIN`（上游构建机路径前缀，patchelf 可用时顺手裁掉，缺工具只 warn
 *   不报错——`$ORIGIN` 本身已在）。⚠️ **libstdc++ 那半边没解决**：逐文件解析
 *   `.gnu.version_r` 实测 1.12.40 的 sherpa-onnx.node 要 GLIBCXX_3.4.29
 *   （`std::__throw_bad_array_new_length`，GCC 11 才引入），而 UOS 20 / Debian
 *   10 的 libstdc++ 只到 3.4.25 —— 这一版仍然装不上 UOS，装机是 dlopen 报
 *   `version 'GLIBCXX_3.4.29' not found`。`check-linux-glibc.js` 两条轴都量，
 *   所以在打包期就会红（不是装机才暴露）。真要上 UOS，只有随包自带
 *   libstdc++.so.6 或 zig 自编（libc++ 静态）两条路。**同一个 SenseVoice 模型包
 *   通吃两代引擎**（opset 13 / ir_version 7，远低于两边 ORT 的下限），所以
 *   mac/win 继续随 sherpa-onnx-node 的 2.0.2，不需要跨平台统一版本（1.12.40 的
 *   mac 包 minos 14/15，装不进老系统——统一反而更糟）。
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

// 逐平台版本钉：只有 linux 需要与 sherpa-onnx-node（2.0.2）分家，理由见文件头。
const PLATFORM_PINS = {
  'linux-x64': '1.12.40',
}

/**
 * Linux 私有 C++ 运行库（2026-11-23 裁定 ①：随包自带 libstdc++）。
 *
 * 为什么不是「塞一个 libstdc++.so.6」——**glibc 按 SONAME 去重**。`_dl_lookup_map`
 * 的注释原文："If the requested name matches the soname of a loaded object, use
 * that object."（glibc elf/dl-load.c）。Linux 上进程里几乎必然先有系统 libstdc++
 * （node / Electron 自身就链着它），于是同名的随包副本**根本不会被打开**，引擎
 * 对象上的 RUNPATH 也不生效 —— 结果还是 `version 'GLIBCXX_3.4.29' not found`。
 * 所以副本改名 `libpmcxx.so.6`（SONAME 已改成它），并把引擎四个对象 .dynstr 里的
 * NEEDED `libstdc++.so.6` 一起改过去：两份 libstdc++ 靠不同 SONAME 共存。
 *
 * 来源与制作步骤（含 sha256、GCC 版本、许可）在 resources/cxx-runtime/README.md。
 * 这份 blob 必须满足：自身 GLIBC ≤ 2.28（实测 2.17）、提供 GLIBCXX ≥ 3.4.29
 * （实测到 3.4.30），否则等于把失败从引擎搬到运行库身上。
 */
const LINUX_CXX = {
  name: 'libpmcxx.so.6',
  replaces: 'libstdc++.so.6',
  blob: join(REPO, 'resources', 'cxx-runtime', 'linux-x64', 'libpmcxx.so.6'),
  // 防误替换：prepare 每次都验，blob 换了但没更新这里就当场失败
  sha256: '85964cabf42087d9145a99e3c45b904f0e2760002f8d4b1dc73d8382f122cc09',
}

/** 读 ELF64 的 `.dynstr` 段范围（纯字节解析，不依赖 readelf/patchelf）。 */
function dynstrRange(buf) {
  if (buf.length < 64 || buf[0] !== 0x7f || buf.toString('latin1', 1, 4) !== 'ELF' || buf[4] !== 2) {
    throw new Error('不是 ELF64 —— 只有 linux 平台包才走这条')
  }
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shentsize = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const shstrndx = buf.readUInt16LE(0x3e)
  if (shoff === 0 || shnum === 0) throw new Error('没有节头表（被 strip 过？）—— 无法定位 .dynstr')
  const section = (i) => ({
    nameOff: buf.readUInt32LE(shoff + i * shentsize),
    offset: Number(buf.readBigUInt64LE(shoff + i * shentsize + 24)),
    size: Number(buf.readBigUInt64LE(shoff + i * shentsize + 32)),
  })
  const shstr = section(shstrndx)
  const sectionName = (s) => {
    const end = buf.indexOf(0, shstr.offset + s.nameOff)
    return buf.toString('latin1', shstr.offset + s.nameOff, end)
  }
  for (let i = 0; i < shnum; i++) {
    const s = section(i)
    if (sectionName(s) === '.dynstr') return s
  }
  throw new Error('找不到 .dynstr 段')
}

/**
 * 把 `.dynstr` 里的 `from\0` 原地改成 `to\0`（要求 `to` 不更长，尾部用 NUL 补齐）。
 * 只动字符串表的内容、不动偏移：DT_NEEDED / DT_SONAME 的 d_val 是表内偏移，
 * 所以这是最安全的一种改名方式（无需 patchelf）。返回替换处数。
 */
function patchDynstrName(buf, from, to) {
  const fromBytes = Buffer.from(`${from}\0`, 'latin1')
  const toBytes = Buffer.from(`${to}\0`, 'latin1')
  if (toBytes.length > fromBytes.length) throw new Error(`新名更长：${to} > ${from}（原地替换会越界）`)
  const range = dynstrRange(buf)
  const end = range.offset + range.size
  const replacement = Buffer.concat([toBytes, Buffer.alloc(fromBytes.length - toBytes.length)])
  let count = 0
  let at = range.offset
  for (;;) {
    const hit = buf.indexOf(fromBytes, at)
    if (hit === -1 || hit + fromBytes.length > end) break
    replacement.copy(buf, hit)
    count++
    at = hit + fromBytes.length
  }
  return count
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** manifest 版本必须来自**源平台包自己**的 package.json（2.0.2 的默认值会让 Linux 写出假版本） */
function sourceVersion(pkgDir) {
  const pkgJson = join(REPO, 'node_modules', pkgDir, 'package.json')
  if (existsSync(pkgJson)) return JSON.parse(readFileSync(pkgJson, 'utf8')).version
  // 平台包缺席时只能回落到 meta 包（仅用于报错提示里的版本号）
  const nodePkg = join(REPO, 'node_modules', 'sherpa-onnx-node', 'package.json')
  return existsSync(nodePkg) ? JSON.parse(readFileSync(nodePkg, 'utf8')).version : 'unknown'
}

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
  const version = sourceVersion(pkgDir)
  const pin = PLATFORM_PINS[platformArch]
  if (!existsSync(src)) {
    console.error(`✗ ${pkgDir} 不在 node_modules —— 先 npm i --no-save ${pkgDir}@${pin ?? version}`)
    process.exit(1)
  }
  if (!required.every((f) => existsSync(join(src, f)))) {
    console.error(`✗ ${platformArch} 包缺必备文件（需要 ${required.join(' + ')}）`)
    process.exit(1)
  }
  // 钉住的平台装错版本：manifest 仍如实写实际版本（sha/版本门对得上），
  // 但 glibc 门禁会在打包期拦下超 2.28 的产物——早说一句省一轮 CI。
  if (pin && version !== pin) {
    console.warn(`⚠ ${platformArch} 应装 ${pin}（GLIBC ≤2.28 的唯一可用版本），node_modules 里是 ${version} —— check-linux-glibc.js 会拦下超限产物`)
  }

  const dest = join(DEST_ROOT, platformArch)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const f of required) cpSync(join(src, f), join(dest, f))

  // linux：随包私有 libstdc++（为什么必须改名见 LINUX_CXX 注释），并把四个引擎
  // 对象的 NEEDED 一起改到私有 SONAME。改的是 .dynstr 内容、不动偏移，所以
  // 不需要 patchelf —— CI 容器装不了 apt，这条路本来也走不通。
  const shipped = [...required]
  if (platform === 'linux') {
    if (!existsSync(LINUX_CXX.blob)) {
      console.error(`✗ 缺私有 C++ 运行库 ${LINUX_CXX.blob} —— 见 resources/cxx-runtime/README.md`)
      process.exit(1)
    }
    const actual = sha256Of(LINUX_CXX.blob)
    if (actual !== LINUX_CXX.sha256) {
      console.error(`✗ ${LINUX_CXX.name} sha256 不符（期望 ${LINUX_CXX.sha256}，实际 ${actual}）—— blob 换了就要同步脚本里的钉子`)
      process.exit(1)
    }
    cpSync(LINUX_CXX.blob, join(dest, LINUX_CXX.name))
    shipped.push(LINUX_CXX.name)

    const stale = Buffer.from(`${LINUX_CXX.replaces}\0`, 'latin1')
    for (const f of required) {
      const p = join(dest, f)
      const buf = readFileSync(p)
      const n = patchDynstrName(buf, LINUX_CXX.replaces, LINUX_CXX.name)
      if (n === 0) {
        console.error(`✗ ${f} 的 .dynstr 里没有 ${LINUX_CXX.replaces} —— 厂商包结构变了，引擎会在目标机上加载失败`)
        process.exit(1)
      }
      const range = dynstrRange(buf)
      if (buf.subarray(range.offset, range.offset + range.size).includes(stale)) {
        console.error(`✗ ${f} 改完仍残留 ${LINUX_CXX.replaces} 的 NEEDED —— 只改了 ${n} 处，别放过`)
        process.exit(1)
      }
      writeFileSync(p, buf)
    }
    console.log(`  ↳ ${platformArch} 私有 C++ 运行时 ${LINUX_CXX.name} 已随包（${required.length} 个引擎对象 NEEDED 已改名）`)
  }

  // mac：签名一致性（文件未改，但换目录后 ad-hoc 重签最便宜且确定）
  if (platform === 'darwin') {
    const hasRpath = (run('otool', ['-l', join(dest, 'sherpa-onnx.node')]) ?? '').includes('@loader_path')
    if (!hasRpath) {
      console.error(`✗ ${platformArch}/sherpa-onnx.node 缺 @loader_path rpath —— dylib 将无法解析（M0-4 门红）`)
      process.exit(1)
    }
    for (const f of required) run('codesign', ['--force', '--sign', '-', join(dest, f)])
  }

  // linux：裁掉上游 RUNPATH 里的构建机前缀（1.12.40 已烘焙 $ORIGIN，缺 patchelf
  // 只失去「裁前缀」这一项，不影响加载）
  if (platform === 'linux') {
    const patched = run('patchelf', ['--set-rpath', '$ORIGIN', join(dest, 'sherpa-onnx.node')])
    if (!patched) {
      console.warn(
        `⚠ patchelf 不可用或失败：${platformArch}/sherpa-onnx.node 的 RUNPATH 保持上游原样（$ORIGIN 已在，可正常加载；装 patchelf 可顺手裁掉构建机前缀）`,
      )
    }
  }

  // manifest：版本 + 逐文件 sha256（主进程加载器的 sha 门数据源）。
  // linux 的私有 libstdc++ 也在里面——它和引擎同生共死，漏了就等于没有 sha 证据。
  const files = {}
  for (const f of shipped) {
    files[f] = sha256Of(join(dest, f))
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ version, platformArch, files }, null, 2), 'utf8')
  const total = shipped.reduce((a, f) => a + statSync(join(dest, f)).size, 0)
  console.log(`✓ asr-engine ${platformArch} 就绪（v${version}, ${(total / 1048576).toFixed(1)}MB, ${shipped.length} files, sha manifest 写入）`)
}

function main() {
  const idx = process.argv.indexOf('--platform-arch')
  const targets = idx >= 0 ? process.argv[idx + 1].split(',') : [`${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`]
  // 只清目标子目录：以前这里 `rmSync(DEST_ROOT)` 会把别的平台目录一起删掉，
  // 一次失败的跨架构尝试就能毁掉本机已备好的引擎（2026-11-23 实测踩过）。
  mkdirSync(DEST_ROOT, { recursive: true })
  for (const t of targets) prepare(t)
}

module.exports = { patchDynstrName, dynstrRange, LINUX_CXX }

if (require.main === module) main()
