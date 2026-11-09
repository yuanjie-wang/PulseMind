import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ORT_WEB_FILES } from '../src/main/services/ocr'

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

// 护栏：ocr.ts 不给 ORT 任何路径（env.wasm.wasmPaths 保持不设），ORT 在 Node 下执行
// import('./ort-wasm-simd-threaded.mjs')，由 Node 按 ort.node.min.js 自己的位置解析；
// .wasm 与 pthread worker 再由 .mjs 的 import.meta.url 派生。曾经给的是绝对路径
// `dir + sep`：ORT 先 new URL(文件名, 前缀)（lib/wasm/wasm-utils-import.ts 的
// normalizeUrl），失败就把「前缀+文件名」原样 import()——Windows 盘符在这里被 ESM
// loader 当成 scheme `f:`，装机报 "no available backend found. ERR: [wasm] …
// ERR_UNSUPPORTED_ESM_URL_SCHEME"。9103325 只修了打包冒烟、没修 ocr.ts，门禁因此一直是绿的。
const MJS = 'ort-wasm-simd-threaded.mjs'
const WASM = 'ort-wasm-simd-threaded.wasm'

describe('ORT finds its runtime files relative to itself (wasmPaths stays unset)', () => {
  it('ocr.ts never sets env.wasm.wasmPaths, and requires ORT at runtime from the resolved dir', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/main/services/ocr.ts'), 'utf8')
    expect(src).not.toMatch(/wasmPaths\s*=/)
    // 相对解析的参照点是 ort.node.min.js 自己的位置：它必须在运行时从该目录 require，
    // 打进 bundle 的话参照点就成了 out/main，另外两件就找不到了
    expect(src).toContain("require(join(dir, 'ort.node.min.js'))")
  })

  it('the three files ocr.ts requires side by side are exactly what extraResources ships', () => {
    const entry = (pkg.build.extraResources || []).find((e) => e.to === 'ort-web')
    expect([...ORT_WEB_FILES]).toEqual(entry.filter)
  })

  it('Windows: the relative lookup never yields a bare drive-letter specifier', () => {
    for (const dir of [
      'F:\\PulseMind\\resources\\ort-web',
      'D:\\软件 目录\\#1 100%\\resources\\ort-web',
      '\\\\nas\\share\\PulseMind\\resources\\ort-web'
    ]) {
      // Node 对 CJS 模块里的 import('./…')：以该模块自己的 file URL 为基准解析
      const mjs = new URL(`./${MJS}`, pathToFileURL(`${dir}\\ort.node.min.js`, { windows: true }))
      expect(mjs.protocol).toBe('file:')
      expect(fileURLToPath(mjs, { windows: true })).toBe(`${dir}\\${MJS}`)
      // Emscripten 胶水对 .wasm：new URL(文件名, import.meta.url)，Node 下再 readFileSync(URL)
      expect(fileURLToPath(new URL(WASM, mjs), { windows: true })).toBe(`${dir}\\${WASM}`)
    }
  })

  it('POSIX: # and % in the install path survive the same lookup', () => {
    const dir = '/opt/软件 目录/#1 100%/resources/ort-web'
    const mjs = new URL(`./${MJS}`, pathToFileURL(`${dir}/ort.node.min.js`, { windows: false }))
    expect(fileURLToPath(mjs, { windows: false })).toBe(`${dir}/${MJS}`)
    expect(fileURLToPath(new URL(WASM, mjs), { windows: false })).toBe(`${dir}/${WASM}`)
  })

  it('why not the old absolute path: a drive letter cannot be a URL base and parses as scheme f:', () => {
    expect(() => new URL(MJS, 'F:\\PulseMind\\resources\\ort-web\\')).toThrow()
    expect(new URL(`F:\\PulseMind\\resources\\ort-web\\${MJS}`).protocol).toBe('f:')
  })

  it('the packed smoke drives ocr.ts itself and fails if a path is handed to ORT again', () => {
    const smoke = readFileSync(resolve(process.cwd(), 'scripts/smoke-packed-ocr.js'), 'utf8')
    expect(smoke).toContain("'src', 'main', 'services', 'ocr.ts'")
    expect(smoke).toContain('warmUpOcr()')
    expect(smoke).toContain('w.wasmPaths !== undefined')
    // 只认真正的属性赋值（`ort.env.wasm.x = …`），不误伤报错文案里的同名字样
    expect(smoke).not.toMatch(/\.env\.wasm\.\w+\s*=(?!=)/)
  })
})
