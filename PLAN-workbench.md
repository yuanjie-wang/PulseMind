# PulseMind Plan —— 右侧工作台（Workbench）：浏览器 / 文件 / 计划 三合一

> **目标**：把右侧的浏览器面板、文件预览面板、计划面板合并为一个页签式工作台；计划页签以真实 DAG 图（SVG，零依赖）展示节点依赖与进度，替代线性 PlanPanel。
> **决策确认（2026-09-16 用户逐项裁定）**：DAG 用**手写 SVG**（零新依赖，布局基于 `planLayers()`）；文件页签 v1 **沿用只读预览**；**create_plan 成功自动打开**工作台计划页签（照搬 write 自动弹预览的先例）；**移除计划悬浮球**，输入框上方留一条极细状态条（点击打开工作台）。

## 已定决策

| # | 决策点 | 结论 |
|---|--------|------|
| W1 | 面板关系 | 三者合并为单一 `WorkbenchPane`（absolute 右缘 + 左缘拖拽把手 + 单一宽度），`paddingRight` 从两段相加变一段 |
| W2 | 宽度 | 工作台单一宽度（默认 420，`clampPaneWidth`），页签共享；浏览器页签激活时拖拽同步推主进程 |
| W3 | 原生 WebView 折叠 | `BrowserPaneState` 增加 `browserActive`（工作台是否停在浏览器页签）：false 时主进程 `setVisible(false)` 折叠原生视图，标签页保活 |
| W4 | 几何 | 外层页签条 32px 并入 chrome——`PANE_CHROME_HEIGHT` 68→100（两端共享常量，一处改动对齐原生 dock） |
| W5 | 自动切换 | 主进程推来的浏览器标签 0→N 时自动开工作台并切到浏览器页签；create_plan（plan null→有）自动开并切到计划页签 |
| W6 | DAG 渲染 | `shared/plan/layout.ts` 纯布局（波次=纵列、波内按依赖重心排序减少交叉、贝塞尔依赖线、blocked 边虚线）+ `PlanGraphView` SVG 渲染；点击节点跳 `msgId` |
| W7 | 状态归属 | `workbenchStore`（open/width/activeTab，persist width）；previewPaneStore 只留页签数据，openFile 联动开工作台；浏览器可见性仍由主进程推送 |
| W8 | 计划悬浮球 | 删除 PlanPanel；活跃计划且工作台关闭时，InputArea 顶部细条显示进度（可选 prop，默认不渲染） |

## 任务

- [x] T1 协议+主进程：`browserActive` 字段、`syncPane` 折叠逻辑、`PANE_CHROME_HEIGHT`=100
- [x] T2 `shared/plan/layout.ts` 纯布局 + 测试
- [x] T3 `workbenchStore` + previewPane 联动
- [x] T4 `PlanGraphView`（SVG）+ `WorkbenchPane`（页签/徽标/拖拽）
- [x] T5 BrowserPaneChrome / PreviewPane `embedded` 化
- [x] T6 ChatView/App 接线（单宽度预留、自动切换、状态条）、删除 PlanPanel
- [x] T7 全量验证（vitest + eslint + tsc 双基线）：58 文件 539 测试全绿；web tsc 14 个残留（低于基线 16）；触碰文件 lint 零新增
