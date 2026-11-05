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
// 纯机械操作；OCR 依赖未安装时静默跳过，不影响正常构建。

const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

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
