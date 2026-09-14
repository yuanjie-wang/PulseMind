# PulseMind Plan —— 对话页文件预览面板（Preview Pane）

> **目标**：参照豆包「侧边工作台」/ WorkBuddy「结果区」，AI 执行文档类任务时在对话右侧提供一个专用预览面板——产出的文件以标签页形式实时渲染，写入即弹出、编辑即刷新。补上「AI 写了文件 → 用户要自己去文件夹打开」这段断链。
> **范围裁定（2026-09-14 用户确认）**：本期只做**纯渲染层面板**——零新依赖、零新 IPC 通道（`readFile`/`getFileStat`/`copyFile`/`openFolder`/`convertFileToMarkdown` 均已在桥上）。Office 预览整体延后（D1）、「变更」diff 视图放二期（D2）。
> **执行方式**：逐任务执行，每任务完成后跑 `npm test` + `npx tsc -p tsconfig.web.json --noEmit` + `npx tsc -p tsconfig.node.json --noEmit` 对基线只升不降，并在本文档勾选。全程遵守 AGENTS.md（类 ≤1000 行、方法 ≤200 行、先检索 utils 再动手）。

---

## 一、已定决策

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | Office 预览（docx/xlsx/pptx/pdf，含 markitdown 内容预览） | **整体延后**；本期显示 fallback 卡片（文件信息 +「在系统中打开」） |
| D2 | 「变更」diff 视图（本次任务改了哪些文件、前后对照） | **二期**（需 file-ops 插桩 + 修订记录，另行立项） |
| D3 | 自动弹出行为 | **write 成功产出可预览文件即自动展开面板**并打开该标签；edit 仅刷新已打开标签——不抢焦点、不自动开新标签 |
| D4 | 布局模式 | 照搬 BrowserPane 先例：absolute 右侧面板 + 左缘 6px 拖拽把手 + 根容器 paddingRight 预留；与浏览器面板**叠放共存**（preview 偏移到 browserPane 左侧） |
| D5 | 宽度记忆 | zustand persist（localStorage）；不进 settings.json（browserPane 存 settings 是因主进程 dock 需要坐标，preview 纯渲染层无此需求） |
| D6 | v1 可预览类型 | markdown、text/代码、image、html、csv；其余一律 fallback 卡片 |
| D7 | 刷新机制 | 会话事件驱动（`onAgentSessionEvent` 中 diff write/edit 成功事件），不引入 fs.watch |
| D8 | HTML 预览 | `<iframe sandbox="allow-scripts" src="local-file://…">`——脚本可运行、无 same-origin；CSP `frame-src 'none'` → `frame-src local-file:` |

## 二、设计

### 1. 类型检测（共享纯函数）
`src/shared/preview/file-kind.ts`：`detectFileKind(path)` → `'markdown' | 'text' | 'image' | 'html' | 'csv' | 'office' | 'binary'`；`isPreviewable(kind)`。扩展名映射收敛在此；T3 接图片渲染时 `LocalImage.tsx` 的 IMAGE_EXTS 改为从此导入（单一口径）。

### 2. 状态模型
`stores/previewPaneStore.ts`（模式照 `browserPaneStore.ts`）+ `stores/preview-tabs.ts`（纯标签组操作，可单测）：

```
PreviewTab { path, kind, title }        // path 即 tab 身份，同文件不重复开
{ open, width,
  tabsByConversation: Record<convId, PreviewTab[]>,   // 会话隔离，LRU ≤10 会话
  activeByConversation: Record<convId, path|null>,
  activeConversationId, reloadTicks: Record<path, n>,
  openFile / closeTab / setActive / setWidth / setOpen /
  switchConversation / bumpReload / forgetConversation }
```

### 3. 面板 UI（`components/preview/`）
`PreviewPane.tsx`：标签条 + 工具栏（刷新 / 在系统中打开 / 另存为 / 关闭）+ 左缘拖拽把手；宽度 clamp 复用 `shared/browser/pane.ts` 的 `clampPaneWidth`（min 320 / max 60% 聊天区）。渲染器按 kind 分发，一 kind 一组件：

| kind | 渲染方式 |
|------|----------|
| markdown | `XMarkdown`（复用 CodeBlock / LocalImage / Latex 组合） |
| text | `CodeHighlight` + `resolveCodeLang` |
| image | `LocalImage`（local-file:// + ImageViewer 灯箱） |
| html | iframe sandbox（D8） |
| csv | `shared/preview/csv.ts` 纯函数解析 + 自绘表格，前 500 行 + 截断提示 |
| office / binary | fallback 卡片：文件名 / 大小 / mtime +「在系统中打开」 |

### 4. 入口与联动
- **工具卡片**：`MessageGroup.tsx` 的 `CollapsibleToolBlock` 头部，对 `write`/`edit` 且 `input.file_path` 存在的块加「预览」按钮（模式照 spawn_agent 眼睛按钮）。
- **FileRefChip**：点击行为从「系统打开」改为「应用内预览」；系统打开入口移至面板工具栏（行为变更点）。
- **自动弹出/刷新**：`hooks/usePreviewPaneSync.ts` 订阅 `onAgentSessionEvent`，从 messages 事件 diff 出 write 成功 → `openFile`；write/edit 成功且路径命中已开标签 → `bumpReload` 重读。判定逻辑写成纯函数配单测。

## 三、文件变更清单

**新增**：`src/shared/preview/file-kind.ts`、`src/shared/preview/csv.ts`、`stores/previewPaneStore.ts`、`stores/preview-tabs.ts`、`components/preview/*`（Pane + 渲染器）、`hooks/usePreviewPaneSync.ts`、`tests/preview-*.test.ts`
**修改**：`ChatView.tsx`（挂载 + paddingRight 合计）、`MessageGroup.tsx`（预览按钮）、`FileRefChip.tsx`（点击行为）、`src/renderer/index.html`（CSP）、i18n zh/en、`AGENTS.md`/`CLAUDE.md`

## 四、里程碑

- [ ] **T1 基础设施**：本文档落盘；file-kind / csv / preview-tabs 纯函数 + 三个测试文件全绿；previewPaneStore
- [ ] **T2 面板骨架**：PreviewPane chrome + 挂载 ChatView + 拖拽/宽度记忆/会话标签隔离；先接 Markdown 渲染（验收：手动 openFile 能看 md）
- [ ] **T3 渲染器矩阵**：text/code、image（CSP 变更）、html、csv、fallback；加载/错误态（验收：六类文件各自渲染正确，HTML 脚本可运行且无 same-origin）
- [ ] **T4 入口与联动**：工具卡片预览按钮、FileRefChip 行为切换、usePreviewPaneSync 自动弹出 + 刷新（验收：AI 写 md → 面板自动弹出；再 edit → 内容自动更新）
- [ ] **T5 收尾**：i18n、`npm run build` 打包冒烟（local-file:// 打包版可用）、AGENTS/CLAUDE 文档、回归

## 五、非目标（本期不做）

Office 任何形式预览（D1）、变更 diff 视图（D2）、面板内编辑、文件树/工作空间浏览、fs.watch 监听、产物聚合视图、选区引用提问（「指哪改哪」）。

## 六、二期路线图

① Office 内容预览（markitdown 链路已通，`convertFileToMarkdown` 已在桥上）→ ② 高保真（mammoth/SheetJS/pdfjs，届时与 PLAN-office-export 依赖决策对齐）→ ③ 变更 diff 视图（svcWriteFile/svcEditFile 插桩 + file_revisions；shell exec 写入盲区一并设计）→ ④ 选区引用提问 → ⑤ 产物聚合视图。

## 执行约定

1. 每任务一分支提交（`feat/fix/docs(scope):`），按任务勾选本文档随提交更新
2. 无 schema 变更、无新依赖
3. 每任务结束保持「中间态可发布」：应用可正常聊天

## 基线（2026-09-14 落纸，只降不升针对本功能引入项）

- `npm test`：337 passed / **8 failed**（`tests/agent-protocol-ws.test.ts`，分支既有——ws-server.ts 尚有未完成改动，与本功能无关）
- `tsc web`：**23 errors**（既有，canvas/CanvasView、useConversationPersistence 等）；`tsc node`：**33 errors**（既有，agent/ws-server.ts 等）；两侧均无 preview 相关错误
- 本功能新增：`tests/preview-*.test.ts` 22 tests 全绿，0 tsc 错误
