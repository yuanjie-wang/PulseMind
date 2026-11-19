// ── 运行视图交付物路径归一（2026-11-18 从 WorkflowRunViewPage 提出来）──
// 契约里 artifacts 是**工作区相对路径**，但模型也可能给绝对路径。渲染端没有
// node:path（沙箱里跑），所以手写两条绝对形态判定：POSIX `/…` 与 Windows 盘符
// `C:\` / `C:/`。
//
// 提成独立纯模块的理由是验收：这条归一错了不会崩，只会让「点开产物」打开一个
// 不存在的路径（`${ws}/workspace/x.md` 这类叠层），而它在组件文件里时连单测都
// 导不进来（React/antd 的 import 链在 node 环境下会炸）。

/** 交付物路径 → 绝对路径。绝对路径原样透传，相对路径挂到工作区根下。 */
export function artifactAbsPath(workspaceDir: string, rel: string): string {
  const p = rel.trim()
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)) return p
  const root = workspaceDir.replace(/[\\/]+$/, '')
  return `${root}/${p.replace(/^\.\//, '')}`
}
