'use strict'

// afterPack：裁掉 onnxruntime-node 里非本平台/本架构的原生二进制。
//
// 背景（2026-11-05 OCR 包体积实测）：onnxruntime-node 把 darwin/win32/linux ×
// x64/arm64 五套二进制全塞在 bin/napi-v6/ 下，npm 解包 293MB（压缩后约 120MB）。
// electron-builder 不认这个内部目录结构，不过滤等于每个平台都背上全平台的重量
// ——dmg 271MB → 391MB（+44%）。按平台过滤后单平台只增 26–41MB（约 +10%）。
//
// 另一处冗余：darwin/arm64 下有两个内容完全相同的 45MB dylib
// （libonnxruntime.1.dylib 与 libonnxruntime.1.31.1.dylib，MD5 一致）——npm 打包
// 时把 symlink 实体化成了两份。删带完整版本号那份是安全的：binding.node 的
// install_name 是 @rpath/libonnxruntime.1.dylib（otool -L 实测，1.31.1）。
//
// 第三处冗余（2026-11-06 实测）：**本架构目录内**还躺着三个执行提供器
// （Execution Provider）动态库，跨平台/跨架构的裁剪管不到它们：
//   linux/x64  libonnxruntime_providers_cuda.so   351.4MB 未压缩
//              libonnxruntime_providers_tensorrt.so  0.8MB
//              libonnxruntime_providers_shared.so    0.0MB
// 合计 352MB —— deb 从 234MB（无 OCR）涨到 370MB 的主因，OCR 本体（模型 15MB +
// ORT 31MB）只该贡献 46MB。win32 下同构（onnxruntime_providers_*.dll）。
//
// 安全性依据不是"应该没事"，是 ELF64 DT_NEEDED 实测：libonnxruntime.so.1 的
// NEEDED 只有 libdl/librt/libpthread/libstdc++/libm/libgcc_s/libc/ld-linux，
// onnxruntime_binding.node 只要 libonnxruntime.so.1 —— 没有一条指向
// providers_*。它们在 ORT 注册对应 EP 时才 dlopen 按名加载，而 services/ocr.ts
// 从不传 executionProviders（走默认 CPU EP），因此永不被加载。
// 需要 GPU 加速时置 PULSEMIND_ORT_KEEP_PROVIDERS=1 跳过本步。
//
// 纯机械操作；OCR 依赖未安装时静默跳过，不影响正常构建。

const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

// 本架构目录里必须仍在场的主库（缺了说明目录不完整，此时不动手）
// 两种命名都要认：linux `libonnxruntime.so.1`（版本号在扩展名后）、
// darwin `libonnxruntime.1.dylib`（版本号在扩展名前）、win32 `onnxruntime.dll`
const MAIN_ORT_LIB = /^(libonnxruntime(\.\d+)*\.(so|dylib)(\.\d+)*|onnxruntime\.dll)$/i
// 执行提供器动态库：linux .so / darwin .dylib / win32 .dll，含带版本号形态
const PROVIDER_LIB = /providers?.*\.(so|dylib|dll)(\.\d+)*$/i
const KEEP_PROVIDERS = process.env.PULSEMIND_ORT_KEEP_PROVIDERS === '1'

// electron-builder 的 Arch 枚举（ia32=0 x64=1 armv7l=2 arm64=3 universal=4）
const ARCH_DIR = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
const PLATFORM_DIR = { darwin: 'darwin', win32: 'win32', linux: 'linux' }
// 带完整版本号的 dylib（binding.node 不引用，可删）
const VERSIONED_DYLIB = /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/
const CANONICAL_DYLIB = 'libonnxruntime.1.dylib'

function unpackedRoot (context) {
  const { appOutDir, electronPlatformName, packager } = context
  return electronPlatformName === 'darwin'
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
    : join(appOutDir, 'resources', 'app.asar.unpacked')
}

function dirSize (p) {
  let total = 0
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

function mb (bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`
}

exports.default = async function stripOrtForeignArch (context) {
  const binRoot = join(unpackedRoot(context), 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6')
  // 未启用 OCR（依赖未安装）或 asarUnpack 未覆盖 → 无事可做
  if (!existsSync(binRoot)) return

  const platform = PLATFORM_DIR[context.electronPlatformName]
  if (!platform) return

  const dropped = []
  const drop = (p, reason) => {
    try {
      const freed = statSync(p).isDirectory() ? dirSize(p) : statSync(p).size
      rmSync(p, { recursive: true, force: true })
      dropped.push({ path: p, freed, reason })
    } catch {
      // 已被删或不可读：目标态已达成
    }
  }

  // 1) 平台互斥：其它平台的二进制整目录删掉
  for (const [name, dir] of Object.entries(PLATFORM_DIR)) {
    if (name === context.electronPlatformName) continue
    const p = join(binRoot, dir)
    if (existsSync(p)) drop(p, `foreign platform (${name})`)
  }

  // 2) 架构互斥：本平台下删掉非目标架构目录；universal 需同时保留
  const keepArch = ARCH_DIR[context.arch]
  const platformDir = join(binRoot, platform)
  if (keepArch && keepArch !== 'universal' && existsSync(platformDir)) {
    for (const entry of readdirSync(platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keepArch) continue
      drop(join(platformDir, entry.name), `foreign arch (${entry.name})`)
    }
  }

  // 3) darwin：删掉冗余的带版本号 dylib（前提：规范名那份在场，链接目标才是它）
  if (platform === 'darwin' && existsSync(platformDir)) {
    for (const entry of readdirSync(platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const archDir = join(platformDir, entry.name)
      if (!existsSync(join(archDir, CANONICAL_DYLIB))) continue
      for (const file of readdirSync(archDir)) {
        if (VERSIONED_DYLIB.test(file)) drop(join(archDir, file), 'duplicate versioned dylib')
      }
    }
  }

  // 4) 本架构目录内的执行提供器库（CUDA / TensorRT / shared）——见文件头注释
  if (!KEEP_PROVIDERS && existsSync(platformDir)) {
    for (const entry of readdirSync(platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const archDir = join(platformDir, entry.name)
      const files = readdirSync(archDir)
      // 前提：主库在场。目录不完整时不动手，避免把残缺目录改得更残缺。
      if (!files.some((f) => MAIN_ORT_LIB.test(f))) continue
      for (const file of files) {
        if (PROVIDER_LIB.test(file)) drop(join(archDir, file), 'unused execution provider')
      }
    }
  }

  if (dropped.length === 0) {
    console.log('[strip-ort-foreign-arch] nothing to strip (already minimal)')
    return
  }
  const total = dropped.reduce((sum, d) => sum + d.freed, 0)
  console.log(
    `[strip-ort-foreign-arch] removed ${dropped.length} item(s), freed ${mb(total)} ` +
    `for ${context.electronPlatformName}/${keepArch || '?'}`
  )
  for (const d of dropped) {
    const rel = d.path.split('napi-v6/').pop() || d.path
    console.log(`  - ${mb(d.freed).padStart(7)}  ${d.reason.padEnd(30)} ${rel}`)
  }
}
