import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 护栏：OCR 运行时已从 onnxruntime-node 换成 onnxruntime-web(WASM)。
// 换回来不只是「慢一点」——node 版的 Windows 二进制把 DirectML EP 静态编进
// onnxruntime.dll，binding.node 在 dlopen 阶段就要加载 DirectML.dll，Win10 1809
// (17763) 上 DllMain 失败给出 1114，且 executionProviders 无法规避（崩在装载期，
// 早于任何 session 选项存在）。所以依赖形态本身要被测试钉死。
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))

describe('OCR runtime is WASM-only', () => {
  it('no onnxruntime-node anywhere in the manifest', () => {
    expect(pkg.dependencies['onnxruntime-node']).toBeUndefined()
    expect(pkg.devDependencies['onnxruntime-node']).toBeUndefined()
    // 进 devDeps 而非 deps：它只被 esbuild 打好的 bundle require，asar 里不需要整包
    expect(pkg.devDependencies['onnxruntime-web']).toBe('1.23.2')
    expect(pkg.dependencies['onnxruntime-web']).toBeUndefined()
  })

  it('ships exactly the wasm triple via extraResources', () => {
    const entry = (pkg.build.extraResources || []).find((e) => e.to === 'ort-web')
    expect(entry).toBeTruthy()
    expect(entry.from).toBe('node_modules/onnxruntime-web/dist')
    expect(entry.filter).toEqual([
      'ort.node.min.js',
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm'
    ])
  })

  it('unpacks nothing for onnxruntime (no native binary to extract)', () => {
    expect((pkg.build.asarUnpack || []).join(' ')).not.toContain('onnxruntime')
  })

  it('models stay outside asar (ONNX needs a real path, not a zip entry)', () => {
    expect((pkg.build.extraResources || []).some((e) => e.to === 'ocr-models')).toBe(true)
  })
})
