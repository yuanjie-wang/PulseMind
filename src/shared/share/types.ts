// PLAN-share-import-export：分享文件 envelope 类型（routine + workflow 统一
// 分享面）。单导出与批量导出同构——恒为 items 数组，读写面只有一份解析器。

export type ShareKind = 'routine' | 'workflow'

export interface ShareItem {
  kind: ShareKind
  /** routine = 消毒后的 Routine 形态（白名单构造）；workflow = 原样透传。 */
  payload: Record<string, unknown>
}

/** `pulsemind-share` v1 envelope。version > 1 拒绝导入（文件来自更新版本）；
 *  format 不符 → 按裸对象 sniff 兜底。 */
export interface ShareEnvelope {
  format: 'pulsemind-share'
  version: number
  exportedAt: string
  items: ShareItem[]
}

/** 导入预览行（shareImportPreview 的产物，主进程构造 → 渲染端模态渲染）。 */
export interface SharePreviewItem {
  index: number
  kind: ShareKind
  name: string
  /** 摘要行（schedule cron 描述 · 参数数 · 批量 · 触发器类型 / 节点数·边数）。 */
  summary: string
  /** 警示行（token 将重置 / 本机路径需检查 / 缺失技能 / 校验错误）。 */
  warnings: string[]
  /** 校验失败的整条置灰不可选（工作流 validate 门 / routine 形态缺失）。 */
  blocked: boolean
  /** 名称冲突（同 kind 内同名已存在）：冲突时 UI 出三选一 Radio。 */
  nameConflict: boolean
  /** 冲突目标的现有行 id（覆盖更新时保留其 id 与 createdAt）。 */
  conflictId?: string
}

/** importPreview 的内存暂存凭据（消毒后的 payload 只在主进程，渲染端只回传
 *  token + 分辨率——杜绝「预览是消毒版、提交是未消毒版」的两版漂移）。 */
export interface ShareImportPreviewResult {
  importToken: string
  items: SharePreviewItem[]
}

export type ShareImportMode = 'create' | 'overwrite' | 'skip'

export interface ShareImportResolution {
  index: number
  mode: ShareImportMode
  /** mode=overwrite 时的目标行 id。 */
  targetId?: string
}

export interface ShareImportCommitResult {
  imported: number
  overwritten: number
  skipped: number
  failed: number
  errors: string[]
}
