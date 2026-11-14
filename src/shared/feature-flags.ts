// ── Shared presentation gates ──
// Same posture as src/renderer/src/feature-flags.ts: the machinery stays shipped
// and functional, only the interface surface is withheld. Put a gate here (rather
// than in the renderer-only module) when BOTH the renderer and the main process
// have to honour it — a hidden surface whose backend still accepts the data is
// how ghost records get created.

/**
 * 工作流任务（TaskKind 'workflow'）的展示面。
 *
 * 2026-11-09 裁定 0.5.1 先隐藏（false）；2026-11-13 放开（true，0.5.2）。
 *
 * true = 五处入口全部打开：任务中心的 workflow 卡片（连 workflow 列表一起拉，
 * 运行/批量两个模态同门）、向导「基本信息」的工作流类型选项、`view.workflowEditing`
 * 路由、运行时间线里的 workflow 行、分享导入的 workflow 条目（预览照常列出，
 * 校验通过即可导入）。
 *
 * 门结构刻意留着没拆：翻回 false 即整族隐藏，而画布/归一/校验/运行器/调度器/store
 * 两条路都原样在包里，数据一条不动——已有 `~/.pulsemind/workflows/*.json` 与
 * `pipeline_runs` 历史不受影响。
 */
export const WORKFLOW_TASKS_UI = true
