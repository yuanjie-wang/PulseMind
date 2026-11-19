/**
 * 模型管理器（通用组件，PLAN-voice-input §3.3）——与语音无关，family 参数化。
 *
 * v1 的第一个 consumer 是 ASR（family='asr'）；OCR 未来大模型包（PP-OCRv5
 * server/公式/表格，100MB+ 级）直接挂 'ocr' family。**只做导入，不做应用内
 * 下载**（2026-11-19 裁定 #7）：模型包获取 = 用户按指引自行下载 zip 后导入，
 * 导入是第一公民不是兜底装饰（内网 UOS 无外网场景是主场景之一）。
 *
 * 落盘形态：
 *   ~/.pulsemind/models/<family>/<modelId>/
 *     manifest.json  ← modelId/version/engineReq/files[{path,sha256,bytes}]，安装记录
 *     model.int8.onnx
 *     tokens.txt
 *
 * 导入语义（P3 安全三道门）：
 *   1. 整包 sha256 门：zip 字节 == models.json 期望（运维的原包直导零告警；
 *      重新打包的 zip 落到逐文件门兜住——模型文件才是真 payload）；
 *   2. 路径监狱：解包目标走 safeChildPath（同 template-tools）；
 *   3. 逐文件 hash 门：models.json.files 逐一对上才安装。
 *   结果 imported / hash-mismatch / version-mismatch / wrong-family，全部给
 *   可读文案（hash-mismatch 带期望 vs 实际前缀对照，方便运维核对）。
 *
 * 原子性：先装进 .tmp-import-<ts>，全绿后 rename 到正式目录——安装中掉电
 * 只留 tmp 残留（下次启动 cleanupTmpInstalls 清扫），正式目录只有原子
 * rename 后才存在。删除 = 整目录 rm。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { DATA_DIR } from '../storage/index'
import { safeChildPath } from '../storage/safe-name'
import { resolveAsrEngineDir } from './asr-engine'

export interface CatalogModelFile {
  path: string
  sha256: string
  bytes: number
}

export interface CatalogModel {
  modelId: string
  displayName: string
  version: string
  engineReq: string
  languages: string[]
  /** 用户拿到的 zip 的期望文件名（指引页与导入时的文件名提示） */
  expectedZip: string
  /** 原包 zip 的 sha256（byte-exact；重打包的 zip 走逐文件门） */
  zipSha256: string
  zipBytes: number
  sizeText: string
  files: CatalogModelFile[]
  /** 获取指引页（静态链接；产品侧托管，见 PLAN §9 遗留 TODO） */
  helpUrl: string
}

export interface ModelCatalog {
  family: string
  engineReq: string
  models: CatalogModel[]
}

export interface InstalledModelInfo {
  modelId: string
  displayName: string
  version: string
  engineReq: string
  languages: string[]
  bytes: number
  dir: string
  installedAt: string
}

export type ImportModelResult =
  | { ok: true; status: 'imported'; modelId: string; warning?: string }
  | { ok: false; status: 'hash-mismatch' | 'version-mismatch' | 'wrong-family' | 'invalid-zip' | 'io-error'; message: string }

export interface FamilySpec {
  /** 家族名（落盘 ~/.pulsemind/models/<family>/） */
  family: string
  /** 家族期望的模型文件：zip 里缺任一件 → wrong-family */
  requiredFiles: string[]
  /** 内置支持清单（随包 resources/<...>/models.json）的仓库相对路径 */
  catalogPath: string
  /** 引擎定位（版本配对用）；ocr 家族未来换成自己的定位器 */
  engineVersion: () => string | null
}

const ASR_FAMILY: FamilySpec = {
  family: 'asr',
  requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  // 测试缝：TEMP HOME / 冒烟需要指向自建的清单（默认随包 resources/asr/models.json）
  catalogPath: process.env.PULSEMIND_ASR_CATALOG ?? join(__dirname, '..', '..', 'resources', 'asr', 'models.json'),
  engineVersion: () => {
    try {
      return resolveAsrEngineDir().version
    } catch {
      return null
    }
  },
}

export function getModelFamilySpec(family: string): FamilySpec {
  if (family === ASR_FAMILY.family) return ASR_FAMILY
  throw new Error(`未知的模型家族：${family}（当前支持：${ASR_FAMILY.family}）`)
}

function modelsRoot(family: string): string {
  return join(DATA_DIR, 'models', family)
}

export function familyModelsDir(family: string): string {
  return modelsRoot(family)
}

/** 读取随包支持清单。清单缺失/损坏 = 空清单 + 错误说明（不让设置页崩）。 */
export function readCatalog(family: string): { catalog: ModelCatalog | null; error: string | null } {
  const spec = getModelFamilySpec(family)
  try {
    const raw = JSON.parse(readFileSync(spec.catalogPath, 'utf8')) as ModelCatalog
    if (raw.family !== family) {
      return { catalog: null, error: `支持清单的 family（${raw.family}）与请求（${family}）不一致` }
    }
    return { catalog: raw, error: null }
  } catch (e) {
    return { catalog: null, error: `读取随包支持清单失败（${spec.catalogPath}）：${e instanceof Error ? e.message : String(e)}` }
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readManifest(dir: string): (InstalledModelInfo & { files?: CatalogModelFile[] }) | null {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledModelInfo
  } catch {
    return null
  }
}

/** 已安装模型列表（manifest 损坏的目录跳过——不报错，留待用户重装） */
export function listInstalledModels(family: string): InstalledModelInfo[] {
  const root = modelsRoot(family)
  if (!existsSync(root)) return []
  const out: InstalledModelInfo[] = []
  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue
      const dir = join(root, entry)
      const manifest = readManifest(dir)
      if (!manifest || manifest.modelId !== entry) continue
      let bytes = manifest.bytes ?? 0
      if (!bytes) {
        try {
          for (const f of readdirSync(dir)) {
            if (f === 'manifest.json') continue
            bytes += statSync(join(dir, f)).size
          }
        } catch {
          /* keep 0 */
        }
      }
      out.push({ ...manifest, bytes, dir })
    }
  } catch {
    /* root unreadable → empty */
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId))
}

/**
 * 选当前用于转写的已装模型目录（v1 单档：第一个匹配清单的模型；多档后由
 * 设置页偏好驱动）。返回 null = 没有已装模型。
 */
export function pickInstalledModelDir(family: string): { modelId: string; dir: string } | null {
  const { catalog } = readCatalog(family)
  const installed = listInstalledModels(family)
  const catalogIds = new Set(catalog?.models.map((m) => m.modelId) ?? [])
  const first = installed.find((m) => catalogIds.has(m.modelId)) ?? installed[0]
  return first ? { modelId: first.modelId, dir: first.dir } : null
}

/** 版本配对：catalog.engineReq 是 semver 区间（现只用 >=X 形态），不满足 → 拒装 */
function engineSatisfies(engineVersion: string | null, engineReq: string): boolean {
  if (!engineVersion) return false
  const m = engineReq.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return true // 不认识的表达式不拦（宁松勿错杀导入）
  const [maj, min, pat] = engineVersion.split('.').map((n) => parseInt(n, 10) || 0)
  return maj > +m[1] || (maj === +m[1] && (min > +m[2] || (min === +m[2] && pat >= +m[3])))
}

/**
 * 导入一个模型 zip。zipPath 来自渲染端 dialog（DIALOG_SHOW_OPEN），主进程
 * 全程不落盘音频类数据、不打开 zip 内可执行内容——只做字节校验与拷贝。
 */
export function importModelZip(family: string, zipPath: string): ImportModelResult {
  const spec = getModelFamilySpec(family)
  const { catalog, error } = readCatalog(family)
  if (!catalog) {
    return { ok: false, status: 'io-error', message: `随包支持清单不可用：${error}` }
  }
  if (!existsSync(zipPath)) {
    return { ok: false, status: 'io-error', message: `找不到选择的文件：${zipPath}` }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch (e) {
    return { ok: false, status: 'invalid-zip', message: `不是有效的 zip 文件：${e instanceof Error ? e.message : String(e)}` }
  }

  // ── 门 1a：清单匹配（按期望文件名或 zipSha256 找条目；找不到 → wrong-family）──
  const zipSha = sha256File(zipPath)
  const entries = zip.getEntries()
  const entryNames = entries.map((e) => e.entryName)
  const containsAll = (model: CatalogModel): boolean => {
    // zip 内文件可能带一层顶层目录（macOS 压缩习惯），按尾部路径匹配
    return model.files.every((f) => entryNames.some((n) => n === f.path || n.endsWith(`/${f.path}`)))
  }
  let matched: CatalogModel | undefined =
    catalog.models.find((m) => m.zipSha256 && zipSha === m.zipSha256) ?? catalog.models.find((m) => m.expectedZip && zipPath.endsWith(m.expectedZip))
  if (!matched) matched = catalog.models.find(containsAll)
  if (!matched) {
    const supported = catalog.models.map((m) => m.expectedZip || m.modelId).join(', ')
    return {
      ok: false,
      status: 'wrong-family',
      message: `这个 zip 不属于「${family}」家族的任何已支持模型（期望：${supported}）。请核对下载指引后重试。`,
    }
  }

  // ── 门 1b：引擎版本配对（catalog 条目的 engineReq）──
  const engineVersion = spec.engineVersion()
  if (!engineSatisfies(engineVersion, matched.engineReq)) {
    return {
      ok: false,
      status: 'version-mismatch',
      message: `模型包「${matched.displayName}」需要引擎版本 ${matched.engineReq}，当前应用引擎版本 ${engineVersion ?? '未知'}。请升级应用，或导入与当前版本匹配的模型包。`,
    }
  }

  // ── 门 2+3：只按清单挑文件解包（路径监狱 + 逐文件 hash）──
  // 不整包解包：清单没列的文件（可执行、越界路径、噪音条目）根本不落盘。
  // zip 内文件可能带一层顶层目录（macOS 压缩习惯），按尾部路径匹配。
  const tmpRoot = join(modelsRoot(family), `.tmp-import-${Date.now()}`)
  try {
    mkdirSync(tmpRoot, { recursive: true })
    for (const f of matched.files) {
      const entry = entries.find((e) => !e.isDirectory && (e.entryName === f.path || e.entryName.endsWith(`/${f.path}`)))
      if (!entry) {
        return {
          ok: false,
          status: 'wrong-family',
          message: `zip 里缺少模型文件「${f.path}」——不是「${matched.displayName}」的完整包。请按指引重新下载。`,
        }
      }
      const target = safeChildPath(tmpRoot, f.path)
      if (!target) {
        return {
          ok: false,
          status: 'hash-mismatch',
          message: `清单文件名「${f.path}」不是安全相对路径（内部错误），已拒绝安装。`,
        }
      }
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, entry.getData())
    }
    // 逐文件 hash 门
    const bad: string[] = []
    for (const f of matched.files) {
      const p = join(tmpRoot, f.path)
      if (!existsSync(p)) {
        bad.push(`${f.path}（缺失）`)
        continue
      }
      const actual = sha256File(p)
      if (f.sha256 && actual !== f.sha256) {
        bad.push(`${f.path}（期望 ${f.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
      }
    }
    if (bad.length > 0) {
      return {
        ok: false,
        status: 'hash-mismatch',
        message: `模型包校验失败，已拒绝安装：${bad.join('; ')}。请重新下载完整的模型包（对照指引页的 sha256）。`,
      }
    }

    // ── 原子安装：tmp → 正式目录 ──
    const finalDir = join(modelsRoot(family), matched.modelId)
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(tmpRoot, finalDir)
    const installedFiles: CatalogModelFile[] = matched.files.map((f) => {
      const p = join(finalDir, f.path)
      return { path: f.path, sha256: sha256File(p), bytes: statSync(p).size }
    })
    const manifest = {
      modelId: matched.modelId,
      displayName: matched.displayName,
      version: matched.version,
      engineReq: matched.engineReq,
      languages: matched.languages,
      bytes: installedFiles.reduce((a, b) => a + b.bytes, 0),
      installedAt: new Date().toISOString(),
      files: installedFiles,
    }
    // manifest 最后写：半拷贝的目录不会出现在 listInstalledModels
    // （readManifest 缺 manifest 的目录直接跳过）
    const manifestPath = safeChildPath(finalDir, 'manifest.json')
    if (!manifestPath) {
      return { ok: false, status: 'io-error', message: '内部错误：manifest 路径非法' }
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, status: 'imported', modelId: matched.modelId }
  } catch (e) {
    return { ok: false, status: 'io-error', message: `安装失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    // rename 成功后 tmpRoot 已不存在；失败路径清残留
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

/** 删除一个已装模型（整目录 rm；manifest 随目录一起消失） */
export function removeModel(family: string, modelId: string): boolean {
  const spec = getModelFamilySpec(family)
  const dir = safeChildPath(modelsRoot(spec.family), modelId)
  if (!dir || !existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 启动清扫：安装中掉电留下的 .tmp-import-* 残留（rename 成功路径不产生） */
export function cleanupTmpInstalls(family: string): number {
  const root = modelsRoot(family)
  if (!existsSync(root)) return 0
  let removed = 0
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('.tmp-import-')) continue
      rmSync(join(root, entry), { recursive: true, force: true })
      removed++
    }
  } catch {
    /* best-effort */
  }
  return removed
}
