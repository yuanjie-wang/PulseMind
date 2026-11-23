// ── 语音模型管理器（PLAN-voice-input M2，2026-11-19）──
// 通用件 family='asr'：只做导入（裁定 #7），三道门 = 整包 sha / 路径监狱 /
// 逐文件 hash。这里钉真临时目录上的行为（与 hook-template-sync.test.ts 同款
// TEMP HOME 隔离——storage/index 的 DATA_DIR 在模块加载时由 HOME 派生，必须
// resetModules + 动态 import），加引擎目录假体的 PULSEMIND_ASR_ENGINE 缝给
// 版本配对供版本号。
//
// 广播/IPC 是 IO，进不了纯 Node 单测——由 asr-wiring.test.ts 的接线扫描钉住。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

let home = ''
let catalogPath = ''
let engineDir = ''
let prevHome = ''
let prevCatalog = ''
let prevEngine = ''

interface TestCatalog {
  family: string
  engineReq: string
  models: Array<{
    modelId: string
    displayName: string
    version: string
    engineReq: string
    languages: string[]
    expectedZip: string
    zipSha256: string
    zipBytes: number
    sizeText: string
    files: Array<{ path: string; sha256: string; bytes: number }>
    helpUrl: string
  }>
}

const MODEL_ID = 'test-sensevoice-model'
const writeCatalog = (models: TestCatalog['models']): void => {
  const catalog: TestCatalog = { family: 'asr', engineReq: '>=2.0.0', models }
  writeFileSync(catalogPath, JSON.stringify(catalog), 'utf-8')
}

/** 内容与清单 pin 全对的模型 zip（真实 hash 回填， happiest path 用） */
function buildModelZip(dir: string, entries: Record<string, string>): string {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content, 'utf-8'))
  const out = join(dir, 'pulsemind-asr-model-test.zip')
  zip.writeZip(out)
  return out
}

/** 引擎目录假体：resolveAsrEngineDir 只认文件存在 + manifest 版本，不 require */
function writeFakeEngine(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-fake-engine-'))
  for (const f of ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib']) {
    writeFileSync(join(dir, f), 'fake')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, platformArch: `${process.platform}-${process.arch}`, files: {} }), 'utf-8')
  return dir
}

async function boot() {
  process.env.HOME = home
  try {
    vi.resetModules()
    const [mm, storage] = await Promise.all([import('../src/main/services/model-manager'), import('../src/main/storage/index')])
    expect(storage.DATA_DIR).toBe(join(home, '.pulsemind'))
    return mm
  } finally {
    process.env.HOME = prevHome
  }
}

beforeEach(() => {
  prevHome = process.env.HOME ?? ''
  prevCatalog = process.env.PULSEMIND_ASR_CATALOG ?? ''
  prevEngine = process.env.PULSEMIND_ASR_ENGINE ?? ''
  home = join(tmpdir(), `pulsemind-asr-mm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(home, '.pulsemind'), { recursive: true })
  const res = mkdtempSync(join(tmpdir(), 'pulsemind-asr-catalog-'))
  catalogPath = join(res, 'models.json')
  engineDir = writeFakeEngine('2.0.2')
  process.env.PULSEMIND_ASR_CATALOG = catalogPath
  process.env.PULSEMIND_ASR_ENGINE = engineDir
  writeCatalog([
    {
      modelId: MODEL_ID,
      displayName: '测试模型（SenseVoice）',
      version: '2024-07-17',
      engineReq: '>=2.0.0',
      languages: ['zh', 'en'],
      expectedZip: 'pulsemind-asr-model-test.zip',
      zipSha256: '',
      zipBytes: 0,
      sizeText: '1 KB',
      files: [
        { path: 'model.int8.onnx', sha256: sha256('MODEL_BYTES'), bytes: 11 },
        { path: 'tokens.txt', sha256: sha256('TOKENS'), bytes: 6 },
      ],
      helpUrl: '',
    },
  ])
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(join(catalogPath, '..'), { recursive: true, force: true })
  rmSync(engineDir, { recursive: true, force: true })
  process.env.HOME = prevHome
  if (prevCatalog) process.env.PULSEMIND_ASR_CATALOG = prevCatalog
  else delete process.env.PULSEMIND_ASR_CATALOG
  if (prevEngine) process.env.PULSEMIND_ASR_ENGINE = prevEngine
  else delete process.env.PULSEMIND_ASR_ENGINE
})

describe('模型导入三道门', () => {
  it('happy path：hash 全对 → imported，manifest 落盘，listInstalledModels 可见', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'MODEL_BYTES', 'tokens.txt': 'TOKENS' })
      const r = await mm.importModelZip('asr', zipPath)
      expect(r).toMatchObject({ ok: true, status: 'imported', modelId: MODEL_ID })
      const installed = mm.listInstalledModels('asr')
      expect(installed).toHaveLength(1)
      expect(installed[0].modelId).toBe(MODEL_ID)
      expect(installed[0].version).toBe('2024-07-17')
      const manifestPath = join(home, '.pulsemind', 'models', 'asr', MODEL_ID, 'manifest.json')
      expect(existsSync(manifestPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      expect(manifest.files[0].sha256).toBe(sha256('MODEL_BYTES'))
      // pickInstalledModelDir 指向安装目录（转写通道的模型源）
      const picked = mm.pickInstalledModelDir('asr')
      expect(picked?.modelId).toBe(MODEL_ID)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wrong-family：zip 缺清单要求的文件 → 拒收并说明缺什么', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'random.bin': 'x' })
      const r = await mm.importModelZip('asr', zipPath)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe('wrong-family')
      expect(r.ok === false && r.message).toContain('model.int8.onnx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hash-mismatch：文件在但内容不对 → 拒收 + 期望/实际前缀对照，且不留半装目录', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'WRONG_BYTES!!', 'tokens.txt': 'TOKENS' })
      const r = await mm.importModelZip('asr', zipPath)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe('hash-mismatch')
      expect(r.ok === false && r.message).toContain('期望')
      expect(r.ok === false && r.message).toContain('实际')
      // 原子性：正式目录不存在，tmp 残留也被 finally 清掉
      const root = join(home, '.pulsemind', 'models', 'asr')
      expect(existsSync(join(root, MODEL_ID))).toBe(false)
      const leftovers = existsSync(root) ? readdirSync(root) : []
      expect(leftovers.filter((e) => e.startsWith('.tmp-import-'))).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('version-mismatch：清单 engineReq 高于引擎版本 → 拒收并带升级指引', async () => {
    const mm = await boot()
    writeCatalog([
      {
        modelId: MODEL_ID,
        displayName: '测试模型',
        version: 'v9',
        engineReq: '>=99.0.0',
        languages: ['zh'],
        expectedZip: 'pulsemind-asr-model-test.zip',
        zipSha256: '',
        zipBytes: 0,
        sizeText: '1 KB',
        files: [
          { path: 'model.int8.onnx', sha256: '', bytes: 0 },
          { path: 'tokens.txt', sha256: '', bytes: 0 },
        ],
        helpUrl: '',
      },
    ])
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'x', 'tokens.txt': 'y' })
      const r = await mm.importModelZip('asr', zipPath)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe('version-mismatch')
      expect(r.ok === false && r.message).toContain('>=99.0.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 2026-11-23：linux 随包引擎钉 1.12.40（mac/win 仍走 sherpa-onnx-node 2.0.2），
  // 清单门槛放宽到 >=1.12.0 后，Linux 用户导入同一份模型包必须过门——这条走真
  // 导入链：失败原因只能是 hash，不能是 version-mismatch。
  it('linux 钉版 1.12.40 过得了版本门（清单门槛 >=1.12.0）', async () => {
    const linuxEngine = writeFakeEngine('1.12.40')
    process.env.PULSEMIND_ASR_ENGINE = linuxEngine
    try {
      const mm = await boot()
      writeCatalog([
        {
          modelId: MODEL_ID,
          displayName: '测试模型',
          version: 'v1',
          engineReq: '>=1.12.0',
          languages: ['zh'],
          expectedZip: 'pulsemind-asr-model-test.zip',
          zipSha256: '',
          zipBytes: 0,
          sizeText: '1 KB',
          // 故意不给对：让链路继续跑过版本门，停在 hash 门
          files: [
            { path: 'model.int8.onnx', sha256: sha256('EXPECTED'), bytes: 11 },
            { path: 'tokens.txt', sha256: sha256('TOKENS'), bytes: 6 },
          ],
          helpUrl: '',
        },
      ])
      const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
      try {
        const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'DIFFERENT', 'tokens.txt': 'TOKENS' })
        const r = await mm.importModelZip('asr', zipPath)
        expect(r.ok).toBe(false)
        expect(r.ok === false && r.status).toBe('hash-mismatch')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(linuxEngine, { recursive: true, force: true })
      process.env.PULSEMIND_ASR_ENGINE = engineDir
    }
  })

  it('invalid-zip：不是 zip → 可读报错', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const notZip = join(dir, 'fake.zip')
      writeFileSync(notZip, 'this is not a zip file')
      const r = await mm.importModelZip('asr', notZip)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe('invalid-zip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('幂等重装：同一 zip 导两次仍是一个条目（先 rm 后 rename）', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'MODEL_BYTES', 'tokens.txt': 'TOKENS' })
      expect((await mm.importModelZip('asr', zipPath)).ok).toBe(true)
      expect((await mm.importModelZip('asr', zipPath)).ok).toBe(true)
      expect(mm.listInstalledModels('asr')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('带一层顶层目录的 zip（Finder 压缩习惯）也能导入', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'wrapped/model.int8.onnx': 'MODEL_BYTES', 'wrapped/tokens.txt': 'TOKENS' })
      const r = await mm.importModelZip('asr', zipPath)
      expect(r).toMatchObject({ ok: true, status: 'imported' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('删除与清扫', () => {
  it('removeModel：整目录删除；未知 id 返回 false', async () => {
    const mm = await boot()
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-zip-'))
    try {
      const zipPath = buildModelZip(dir, { 'model.int8.onnx': 'MODEL_BYTES', 'tokens.txt': 'TOKENS' })
      await mm.importModelZip('asr', zipPath)
      const modelDir = join(home, '.pulsemind', 'models', 'asr', MODEL_ID)
      expect(existsSync(modelDir)).toBe(true)
      expect(mm.removeModel('asr', MODEL_ID)).toBe(true)
      expect(existsSync(modelDir)).toBe(false)
      expect(mm.removeModel('asr', 'no-such-model')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cleanupTmpInstalls：安装中掉电的 .tmp-import-* 残留被清掉', async () => {
    const mm = await boot()
    const root = join(home, '.pulsemind', 'models', 'asr')
    mkdirSync(join(root, '.tmp-import-123'), { recursive: true })
    mkdirSync(join(root, 'real-model'), { recursive: true })
    expect(mm.cleanupTmpInstalls('asr')).toBe(1)
    expect(existsSync(join(root, '.tmp-import-123'))).toBe(false)
    expect(existsSync(join(root, 'real-model'))).toBe(true)
  })

  it('未知 family 拒收（family 参数化的通用件不静默扩展）', async () => {
    const mm = await boot()
    expect(() => mm.readCatalog('ocr')).toThrow(/未知的模型家族/)
    expect(() => mm.removeModel('nope', 'x')).toThrow(/未知的模型家族/)
    expect(() => mm.pickInstalledModelDir('nope')).toThrow(/未知的模型家族/)
    // 列表读是纯目录枚举：未知 family 无害返回空（不抛）
    expect(mm.listInstalledModels('nope')).toEqual([])
  })
})

describe('随包清单', () => {
  it('真实 resources/asr/models.json 可解析且 pin 值齐全（防手改漏字段）', async () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'resources', 'asr', 'models.json'), 'utf-8')) as TestCatalog
    expect(raw.family).toBe('asr')
    expect(raw.models.length).toBeGreaterThan(0)
    for (const m of raw.models) {
      expect(m.modelId).toBeTruthy()
      expect(m.expectedZip).toBeTruthy()
      expect(m.zipSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.files.length).toBeGreaterThan(0)
      for (const f of m.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('清单候选梯：env 缝在位即命中（读时求值，不依赖模块加载时序）', async () => {
    const mm = await boot()
    // PULSEMIND_ASR_CATALOG 在 beforeEach 已指向自建清单——候选梯必须读到它
    const { catalog, error } = mm.readCatalog('asr')
    expect(error).toBeNull()
    expect(catalog?.models.map((m) => m.modelId)).toContain(MODEL_ID)
  })

  it('清单候选梯全落空 → 空清单 + 列出全部候选的可读错误（H1 失败面，不崩）', async () => {
    const mm = await boot()
    // vitest 是纯 Node：resourcesPath 不存在、env 缝摘掉后 dev 候选也缺席
    delete process.env.PULSEMIND_ASR_CATALOG
    const { catalog, error } = mm.readCatalog('asr')
    expect(catalog).toBeNull()
    expect(error).toContain('随包支持清单缺失')
    expect(error).toContain('候选：')
    expect(error).toContain('models.json')
  })
})

describe('引擎版本配对（2026-11-23：linux 1.12.40 与 mac/win 2.0.2 共用一份清单）', () => {
  it('engineSatisfies：>= 区间语义 + 不认识的表达式宁松勿错杀', async () => {
    const mm = await boot()
    expect(mm.engineSatisfies('1.12.40', '>=1.12.0')).toBe(true)
    expect(mm.engineSatisfies('1.12.0', '>=1.12.0')).toBe(true)
    expect(mm.engineSatisfies('2.0.2', '>=1.12.0')).toBe(true)
    expect(mm.engineSatisfies('1.11.9', '>=1.12.0')).toBe(false)
    expect(mm.engineSatisfies(null, '>=1.12.0')).toBe(false)
    expect(mm.engineSatisfies('0.1.0', 'not-semver')).toBe(true)
  })

  it('随包清单的门槛同时放行 1.12.40 与 2.0.2，且仍拦更老的引擎', async () => {
    const mm = await boot()
    const cat = JSON.parse(readFileSync(join(process.cwd(), 'resources', 'asr', 'models.json'), 'utf-8')) as TestCatalog
    const nodeVersion = (
      JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf-8')) as {
        version: string
      }
    ).version
    // mac/win 跟随 devDep 的 2.x；linux 钉 1.12.40（prepare-asr-engine.js 的 PLATFORM_PINS）
    expect(nodeVersion).toMatch(/^2\./)
    for (const req of [cat.engineReq, ...cat.models.map((m) => m.engineReq)]) {
      for (const v of ['1.12.40', nodeVersion]) {
        expect(mm.engineSatisfies(v, req), `${req} 应放行 ${v}`).toBe(true)
      }
      // 放宽不等于取消：门槛以下的引擎仍拒，否则这道门等于没有
      expect(mm.engineSatisfies('1.11.9', req), `${req} 应拦下 1.11.9`).toBe(false)
    }
  })
})
