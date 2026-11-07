// PLAN-share-import-export：envelope 解析 + 字段消毒（导出/导入不对称的核心）。
//
// 纯函数、零 IO——share.handler 调它们；钉子 tests/share-sanitize.test.ts。
//
// 消毒表（Routine）：
//   剥离：id（导入重铸）、webhook token（秘密；导入端 normalizeTriggers 自动
//         重铸）、sourceConversationId、nextRunAt（调度器簿记）、时间戳
//   保留：name/description/prompt/params/icon/schedule/enabled/approvalMode/
//         batch（csvPath）/workspaceDir/file 触发 paths（本机路径原样保留 +
//         导入预览如实警示——不做智能重映射，猜错比留空更糟）
//   保留+警示：skills（预览列出目标机缺失的技能名）、profileId（无此模型时
//         运行期自然回落激活模型）
// 白名单构造（未知名段一律丢弃）——前向安全，不靠黑名单。

import type { ShareEnvelope, ShareItem, ShareKind } from './types'
import type { WorkflowDefinition } from '../workflow/types'

export const SHARE_FORMAT = 'pulsemind-share'
export const SHARE_VERSION = 1
/** 单条 payload 与整文件的防呆帽（超限显式拒绝，不静默截断）。 */
export const MAX_ITEM_BYTES = 1_000_000
export const MAX_FILE_BYTES = 5_000_000

// ── 导出消毒 ─────────────────────────────────────────────────────

const ROUTINE_EXPORT_FIELDS = [
  'name',
  'description',
  'prompt',
  'params',
  'icon',
  'schedule',
  'enabled',
  'skills',
  'workspaceDir',
  'approvalMode',
  'profileId',
  'batch',
  'triggers',
] as const

/** routine → 分享 payload（白名单构造）。webhook trigger 的 token 在这里剥
 *  （normalizeTriggers 对缺 token 的条目在写入时自动重铸——两端各持各的秘密）。 */
export function sanitizeRoutineForExport(routine: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ROUTINE_EXPORT_FIELDS) {
    if (routine[key] !== undefined) out[key] = routine[key]
  }
  // webhook token 剥离；file 触发的 paths/debounce 原样（本机路径，预览警示）
  if (Array.isArray(out.triggers)) {
    out.triggers = (out.triggers as Array<Record<string, unknown>>).map((t) => {
      if (t.type === 'webhook') {
        const { token, ...rest } = t
        void token
        return rest
      }
      return t
    })
  }
  return out
}

export function buildEnvelope(items: ShareItem[]): ShareEnvelope {
  return { format: SHARE_FORMAT, version: SHARE_VERSION, exportedAt: new Date().toISOString(), items }
}

// ── 导入解析 ─────────────────────────────────────────────────────

/** 裸对象 sniff：routine（string name+prompt 且无 nodes）/ workflow
 *  （nodes+edges）——用户把 workflows/<id>.json 直接拖进来也能导。 */
export function sniffKind(payload: Record<string, unknown>): ShareKind | null {
  if (typeof payload.nodes !== 'undefined' || typeof payload.edges !== 'undefined') {
    if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) return 'workflow'
    return null
  }
  if (typeof payload.name === 'string' && typeof payload.prompt === 'string') return 'routine'
  return null
}

export interface ParsedShareFile {
  items: ShareItem[]
  errors: string[]
}

/** 分享文件解析：envelope（version 门）或裸对象 sniff 兜底；sniff 不中报
 *  「不是可识别的分享文件」。条目帽 + 字节帽防呆。 */
export function parseShareFile(raw: string): ParsedShareFile {
  const errors: string[] = []
  if (raw.length > MAX_FILE_BYTES) return { items: [], errors: [`分享文件超过 ${Math.round(MAX_FILE_BYTES / 1_000_000)}MB 帽`] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { items: [], errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!parsed || typeof parsed !== 'object') return { items: [], errors: ['分享文件必须是 JSON 对象'] }

  const obj = parsed as Record<string, unknown>
  if (obj.format === SHARE_FORMAT) {
    if (typeof obj.version !== 'number' || obj.version > SHARE_VERSION) {
      return { items: [], errors: ['文件来自更新版本的应用，无法导入'] }
    }
    if (!Array.isArray(obj.items)) return { items: [], errors: ['envelope 缺少 items 数组'] }
    const items: ShareItem[] = []
    for (const rawItem of (obj.items as unknown[]).slice(0, 200)) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const item = rawItem as Record<string, unknown>
      if (item.kind !== 'routine' && item.kind !== 'workflow') continue
      if (!item.payload || typeof item.payload !== 'object') continue
      // payload 也必须 sniff 得过形态——junk 条目静默跳过（宽松读取的同义面）。
      if (!sniffKind(item.payload as Record<string, unknown>)) continue
      items.push({ kind: item.kind, payload: item.payload as Record<string, unknown> })
    }
    if (items.length === 0) errors.push('envelope 中没有可识别的条目')
    return { items, errors }
  }
  // 裸对象兜底
  const kind = sniffKind(obj)
  if (!kind) return { items: [], errors: ['不是可识别的分享文件'] }
  return { items: [{ kind, payload: obj }], errors }
}

// ── 导入预览的数据面 ─────────────────────────────────────────────

export interface PreviewContext {
  /** 本机已存在的任务/工作流名 → id（冲突检测与覆盖更新的 targetId）。 */
  existingNames: Map<string, string>
  /** 本机已安装的技能名（routine 绑定技能的缺失警示）。 */
  installedSkills?: Set<string>
}

/** routine 预览行的警示面：token 重置 / 本机路径 / 缺失技能。 */
export function routinePreviewWarnings(payload: Record<string, unknown>, installedSkills?: Set<string>): string[] {
  const warnings: string[] = []
  const triggers = Array.isArray(payload.triggers) ? (payload.triggers as Array<Record<string, unknown>>) : []
  if (triggers.some((t) => t.type === 'webhook')) warnings.push('webhook token 不随文件携带——导入后将重置（回填新 token）')
  const pathFields: string[] = []
  if (typeof payload.workspaceDir === 'string' && payload.workspaceDir.trim()) pathFields.push('运行工作区')
  if (payload.batch && typeof payload.batch === 'object' && typeof (payload.batch as Record<string, unknown>).csvPath === 'string')
    pathFields.push('批量 CSV 路径')
  const filePaths = triggers.flatMap((t) => (Array.isArray(t.paths) ? (t.paths as string[]) : []))
  if (filePaths.length > 0) pathFields.push(`文件触发路径（${filePaths.length} 个）`)
  if (pathFields.length > 0) warnings.push(`以下为本机路径，请按目标机器检查：${pathFields.join('、')}`)
  const skills = Array.isArray(payload.skills) ? (payload.skills as string[]) : []
  if (installedSkills && skills.length > 0) {
    const missing = skills.filter((s) => !installedSkills.has(s))
    if (missing.length > 0) warnings.push(`本机缺失绑定的技能：${missing.join('、')}（运行时注入将跳过，或先安装/解绑）`)
  }
  return warnings
}

/** routine 摘要行。 */
export function routineSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  const schedule = payload.schedule as Record<string, unknown> | undefined
  if (schedule && typeof schedule.cron === 'string') parts.push(`cron: ${schedule.cron}`)
  const params = Array.isArray(payload.params) ? (payload.params as unknown[]) : []
  if (params.length > 0) parts.push(`参数 ${params.length}`)
  if (payload.batch) parts.push('批量')
  if (triggersCount(payload) > 0) parts.push(`触发器 ${triggersCount(payload)}`)
  parts.push(payload.enabled === false ? '已停用' : '启用')
  return parts.join(' · ') || '单次任务'
}

function triggersCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.triggers) ? (payload.triggers as unknown[]).length : 0
}

/** 工作流预览：payload 原样透传，validate 门在此跑（与 save/启动同一函数——
 *  三处同一门的导入臂）。返回 null = 校验失败（blocked，errors 进 warnings）。 */
export function workflowPreview(
  payload: Record<string, unknown>,
  validate: (def: unknown) => { ok: boolean; errors: string[]; warnings: string[] },
): { warnings: string[]; blocked: boolean } | null {
  const v = validate(payload)
  if (!v.ok) return { warnings: v.errors, blocked: true }
  return { warnings: [...v.warnings], blocked: false }
}

export function workflowSummary(payload: Record<string, unknown>): string {
  const nodes = Array.isArray(payload.nodes) ? (payload.nodes as unknown[]).length : 0
  const edges = Array.isArray(payload.edges) ? (payload.edges as unknown[]).length : 0
  return `${nodes} 节点 · ${edges} 条边${typeof payload.objective === 'string' && payload.objective ? ` · ${payload.objective}` : ''}`
}

/** 从 payload 取显示名（预览行 + 冲突检测 + 导出文件名）。 */
export function shareNameOf(payload: Record<string, unknown>): string {
  return typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : '未命名'
}

/** 工作流定义的透传保证（导出面）：workflow payload 就是 WorkflowDefinition
 *  本体——layout 坐标、params、全部保留。类型面引用，无运行时逻辑。 */
export function workflowExportPayload(def: WorkflowDefinition): Record<string, unknown> {
  return def as unknown as Record<string, unknown>
}
