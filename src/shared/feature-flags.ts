// ── Shared presentation gates ──
// Same posture as src/renderer/src/feature-flags.ts: the machinery stays shipped
// and functional, only the interface surface is withheld. Put a gate here (rather
// than in the renderer-only module) when BOTH the renderer and the main process
// have to honour it — a hidden surface whose backend still accepts the data is
// how ghost records get created.

/**
 * 工作流任务（TaskKind 'workflow'）的展示面（2026-11-09 裁定：0.5.1 先隐藏）。
 *
 * false = 下列入口全部不出现：任务中心的 workflow 卡片、向导「基本信息」的
 * 工作流类型选项、`view.workflowEditing` 路由、运行时间线里的 workflow 行、
 * 分享导入的 workflow 条目（预览标 blocked，提交侧同样拒收）。
 *
 * 保留：画布/归一/校验/运行器/调度器/store 全部原样——翻转成 true 即完整恢复，
 * 已有 `~/.pulsemind/workflows/*.json` 与 `pipeline_runs` 历史一条不动。
 * v0.5.0 没有发布过 workflow 代码，因此线上不存在需要迁移的数据。
 */
export const WORKFLOW_TASKS_UI = false
