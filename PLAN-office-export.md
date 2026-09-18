# PulseMind Plan —— Office 原生输出(xlsx/docx 交付闭环)

> **状态（2026-09-18）**：本计划保留为 **D1–D7 裁定记录**（用户裁定 2026-09-13，仍然有效）。实施计划已按 office-editing 落地后的现状**再基线重写**至 `_task/20260918/PLAN-office-export.md`（六处修正：host 路由替代新 IPC、instructions 替代系统提示词、exceljs 已入库、产物出口改预览/汇总区联动、服务形制照抄 svcEditDocx、护栏指针补齐）——执行以新计划为准，冲突处新计划胜。

> **目标**:让 AI 的产出"拿得走"——用户说"把这份表格整理成 Excel""把这份报告转成 Word"时,能在会话工作目录里拿到真正的 `.xlsx`/`.docx` 文件,消息里点一下就能打开所在文件夹。补上"做数据、写文档"两类的最后一公里。
> **背景**:原综合草案含功能提效 + 工程化底座两条线(内置搜索、模型预设、附件体验、Office 输出、日志/CI/更新、safeStorage/代理/migration 等)。**用户裁定(2026-09-13):仅提取其中 D4(Office 原生输出)立项,其余暂缓**——暂缓项保留在附录 E,恢复排期时以原草案为底稿,本计划不重复展开。
> **读链路现状(为什么只补写链路)**:读 Office 文件已闭环——`read` 工具经 markitdown-js 自动把 PDF/DOCX/PPTX/XLSX 等转 markdown(`tool-executors.ts:73-76`),且有读缓存。缺的只有反向输出:AI 写 xlsx/docx 只能给 markdown/CSV,用户要自己手工转换。
> **执行方式**:逐任务执行,每任务完成后跑 `npm test` + `npx tsc -p tsconfig.web.json --noEmit` + `npx tsc -p tsconfig.node.json --noEmit` 对基线(本文档创建时的仓库收尾状态:`npm test` 138 passed;tsc 两侧 M0.1 实测落纸,只降不升),并在本文档勾选。全程遵守 AGENTS.md(类 ≤1000 行、方法 ≤200 行、先检索 utils 再动手)。

---

## 一、已定决策

| # | 决策点 | 结论 |
|---|---|---|
| D1(沿承) | Office 输出依赖 | **`exceljs` + `docx`**,均纯 JS、无原生编译、无 Electron ABI 问题 |
| D2 | 输出格式范围 | **v1 仅 docx / xlsx / csv**;不做 pptx、不做 PDF(见非目标) |
| D3 | 输入形态 | **`content`(内联 markdown/数据)与 `sourcePath`(转换工作区已有文件)二选一**——大文档走 sourcePath 避免内容在上下文中重复占 token |
| D4(2026-09-13 确认) | xlsx 多表 → 多 sheet 的映射 | **每个二级标题下的表 = 一个 sheet**,标题做 sheet 名 |
| D5(2026-09-13 确认) | 单元格类型推断 | **纯数字转数值**(严格往返才转),前导零/超长数字串保留文本,其余一律文本 |
| D6(2026-09-13 确认) | 同名冲突策略 | **自动加 `-2` 后缀**,与 `shared/workspace-naming.ts` 风格一致 |
| D7(2026-09-13 确认) | 内联 content 大小上限 | **100KB 软上限**,超出返回提示引导改走 sourcePath |

---

## 二、里程碑依赖图

```
M0 基线与依赖冒烟 ─→ M1 主进程导出服务 ─→ M2 内置工具接线与 UI ─→ M3 提示词与端到端验收 ─→ M4 测试回归收尾
```

线性依赖,无并行分支;总量约等于原综合草案中的一个里程碑。

---

## M0 基线冻结与依赖冒烟

- [ ] **M0.1 基线落纸**
  - 范围:记录当前仓库收尾基线——`npm test` 通过数(预期 138)、tsc web/node 两侧错误数、eslint 触及文件清单
  - 验收:数字写入本文档,后续只降不升
- [ ] **M0.2 依赖安装与三处冒烟**
  - 范围:安装 `exceljs`、`docx`(dependencies,主进程 external require 路径)与 `marked`(markdown → AST 解析,零依赖 CJS);冒烟:① plain Node 下 `docx` 生成最小 docx、`exceljs` 生成最小 xlsx(证明 vitest 可做真实产物断言);② `scripts/build.js` external 配置下主进程 require 成功;③ 打包 dir 产物(asar)内 require 成功——exceljs 存在动态 require,必须实测,失败则查 `asarUnpack` 补充
  - 验收:三处冒烟各有实测结论落纸;不通过则记录替代方案后再开工 M1

## M1 主进程导出服务

> 新增 `src/main/services/office-export.ts`。写文件前调 `guardFsTarget(path, 'write')`(`src/main/sandbox/guard.ts`)——会话上下文(AsyncLocalStorage)自动带出项目策略,拒绝自动审计,与既有写文件行为完全一致;越界返回结构化错误,模型可读原因后自行纠正。

- [ ] **M1.1 markdown → docx 映射器**
  - 范围:`marked`(lexer 模式)解析 → 遍历 token 生成 `docx` 元素;映射规则见附录 A;映射器做成**纯函数**(token 流 → 元素描述),不碰 IO,便于单测
  - 边界:不支持的 token(图片/数学/脚注)降级为原文本 + 一行说明,不静默丢失;文档默认字号/行距取 docx 库默认,CJK 依赖 Word/WPS 字体替换(R2)
  - 交付:方法 ≤200 行,映射规则表可独立演进
  - 验收:附录 A 全部规则有对应单测(见 M4.1)
- [ ] **M1.2 xlsx / CSV 组装器**
  - 范围:`exceljs` 生成;输入为 markdown 表格(D4:二级标题分 sheet)或 CSV(exceljs CSV 读取);类型推断按 D5(纯数字→数值,前导零/超长数字串保留文本,推断规则收在纯函数里);CSV 输出统一带 UTF-8 BOM(WPS/Excel 中文乱码预防);CSV 输入含多表时按 D4 同规则拆 sheet
  - 验收:含中文表头、千分位数字、前导零工号的三列表,导出后 Excel 中类型正确、无乱码
- [ ] **M1.3 服务封装 + IPC + preload**
  - 范围:`office-export.ts` 对外只暴露 `exportDocument({ format, content?|sourcePath?, path? })`:解析输入(sourcePath 先经 `guardFsTarget(read)` 且限 markitdown 已支持的文本族:md/csv)、默认命名(首标题 slug + 时间戳,冲突按 D6)、落盘、返回 `{ path, bytes }`;IPC 通道 `office:export`(`src/main/ipc/` 新 handler);preload 桥接;`host/types.ts` 的 `HOST_METHOD_KEYS` 增选 + `electron.d.ts` 类型
  - 验收:越界路径被拒且错误可读;导出文件落在会话工作目录;审计流出现对应 `fs.write` 记录
  - 信息:`feat(office): main-process docx/xlsx export service with sandbox guard`

## M2 内置工具接线与 UI

- [ ] **M2.1 export_document 工具注册**
  - 范围:`src/renderer/src/tools/built-in-tools.ts` 注册 `export_document`(非 gated——交付类任务靠模型自主判断,不设触发词门槛);参数:`format('docx'|'xlsx'|'csv')`、`content?`、`sourcePath?`、`path?`(相对路径,默认会话工作目录);工具描述写清:何时用(D2 格式范围)、两种输入(D3)、大文档建议(D7)、能力边界(附录 A 不支持项)
  - 验收:工具出现在工具表且描述完整;弱模型也能按描述选对 format
- [ ] **M2.2 执行器**
  - 范围:`tool-executors.ts` 增执行分支:相对路径经 `resolveWorkspacePath` 解析(既有私有方法,`:48`);调 `electronAPI.officeExport`;结果串含绝对路径、大小、格式;失败透传结构化原因
  - 验收:相对/绝对路径都正确;拒绝场景模型收到可读错误并能改路径重试
- [ ] **M2.3 导出结果文件卡片**
  - 范围:ChatView 的工具块渲染识别 `export_document` 成功结果,渲染文件卡片(文件名/大小 + 「打开所在文件夹」按钮——走既有 `app.handler.ts:97` 的 `shell.openPath` 能力,复用其通道);i18n zh/en 补齐
  - 验收:导出后消息里点按钮打开工作目录;信息:`feat(office): export_document tool with file card UI`

## M3 提示词与端到端验收

- [ ] **M3.1 系统提示词接线**
  - 范围:`system-prompt-builder.ts` 的工具说明区补一句:需要交付 Excel/Word 文件时用 `export_document`,聊天里贴 markdown 表格不算交付
  - 验收:三个典型 prompt(见 M3.2)首次尝试即选中正确工具与 format
- [ ] **M3.2 端到端走查**(人工)
  - 场景:①"把这份表格整理成 Excel 发我"(多 sheet + 类型正确);②"把这份 markdown 报告转成 Word"(中英混排 + 代码块 + 表格);③"把这个 CSV 转成 Excel";④越界路径("导出到我桌面")→ 被拒 → 模型改用会话目录
  - 验收:产物在 Microsoft Office 与 WPS 中均正常打开;④的拒绝-纠正链路可演示
  - 信息:`feat(office): prompt wiring and end-to-end walkthrough`

## M4 测试回归收尾

- [ ] **M4.1 vitest(真实产物断言)**
  - 范围:`tests/office-export.test.ts`:docx 产物解包断言 `word/document.xml` 含预期文本与结构(adm-zip 已有,零新依赖);xlsx 产物用 exceljs 回读断言单元格值与类型;markdown 映射规则逐条覆盖(附录 A);类型推断纯函数边界用例(前导零/千分位/日期样文本);越界路径拒绝(纯逻辑,mock 守卫)
  - 验收:`npm test` 全绿,基线只升不降
- [ ] **M4.2 i18n 与文档**
  - 范围:zh/en 补齐文件卡片文案;`CLAUDE.md`/`AGENTS.md` 补 `export_document` 工具与 `office-export.ts` 服务
  - 验收:双语无缺失;新概念可查
- [ ] **M4.3 打包冒烟**
  - 范围:打包产物中执行一次 docx + xlsx 导出(M0.2 的 ③ 结论对账);文件卡片与打开文件夹可用
  - 验收:打包版端到端与 dev 版行为一致
  - 信息:`docs(plan): office export regression, docs and packaged smoke`

---

## 附录 A:markdown → docx 映射规则(v1)

| markdown | docx 元素 | 备注 |
|---|---|---|
| `#`–`######` | Heading1–6 | |
| 段落 | Paragraph | 连续空行分段 |
| `**bold**` / `*italic*` / `~~del~~` / `` `code` `` | TextRun 加粗/斜体/删除线/等宽 | 行内嵌套取最外层,v1 不递归组合 |
| `[text](url)` | ExternalHyperlink | |
| 无序/有序列表 | bullet/numbering,嵌套 ≤3 层 | 更深嵌套拍平 |
| 表格 | Table(表头行加粗 + 底纹) | 单元格内行内样式保留加粗/斜体 |
| 代码块 | 单元格式等宽段落 + 浅灰底纹 | 不做语法高亮 |
| 引用块 | 缩进 + 左边框样式段落 | |
| `---` | 水平分隔线 | |
| 图片 | 占位段落"[图片:x.png,正文不支持]" | 不嵌图,明示而非静默 |
| 数学/脚注/HTML 原文 | 原文本 + 文末一行说明 | |

## 附录 B:数据流

```
模型 → export_document 工具调用
  → renderer 执行器(tool-executors.ts,resolveWorkspacePath)
  → IPC office:export
  → main office-export.ts
      → guardFsTarget(path,'write')   // 会话沙箱 + 审计,拒绝返回可读原因
      → content|sourcePath → marked/exceljs → docx|exceljs 产物 buffer
      → 落盘(冲突 D6 后缀) → { path, bytes }
  → 工具结果 → 文件卡片(打开所在文件夹)
```

## 附录 C:新依赖

| 依赖 | 用途 | 形态 | 风险 |
|---|---|---|---|
| `docx` | docx 生成 | 纯 JS(main) | 低 |
| `exceljs` | xlsx/CSV 读写 | 纯 JS(main,~5MB) | 动态 require 需 asar 冒烟(M0.2③) |
| `marked` | markdown → AST | 零依赖 CJS(main) | 低 |

## 附录 D:风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | exceljs 动态 require 与 asar 不兼容 | 打包版导出失败 | M0.2③ 实测;失败补 `asarUnpack` 或换 `xlsx`(SheetJS)方案 |
| R2 | docx 默认字体对 CJK 的渲染依赖打开端替换 | 极端环境字体异常 | Word/WPS 均自动替换;验收覆盖两者;不为 v1 引入字体配置 |
| R3 | 类型推断误伤(如"2026-09"被当日期) | 单元格类型错 | 推断规则白名单式(仅 `Number()` 严格往返转数值),其余一律文本;规则进单测 |
| R4 | 模型把全部内容内联进 content 导致上下文膨胀 | token 浪费 | D7 软上限 + 工具描述引导 sourcePath 路径 |
| R5 | 越界导出到用户任意路径 | 绕过沙箱体验 | 强制 `guardFsTarget`;拒绝原因引导模型用会话目录;审计留痕 |

## 非目标(本期不做)

- 不做 pptx / PDF 生成
- 不做模板化样式(封面/页眉页脚/品牌字体)
- 不做 docx 内嵌图片与图表
- 不做 Office 文件读取增强(读链路 markitdown 已闭环)
- 不做导出历史管理 UI(文件落在会话工作目录,由既有目录条管理)

## 执行约定

1. 每任务一分支提交(沿用 `feat/fix/refactor/docs(scope):` 规范),按任务勾选本文档随提交更新
2. 本计划无 schema 变更;若执行中需要,先补 migration 框架任务再动数据库(见附录 E 暂缓项)
3. 每个任务结束保持"中间态可发布":应用可正常聊天
4. 新代码遵守 AGENTS.md:类 ≤1000 行、方法 ≤200 行、先检索 `src/shared/`、`src/renderer/src/utils/`、`src/main/utils/` 再动手
5. 验收必须包含一次**人工越权尝试**(导出到工作区外被拒)与一次 WPS + MS Office 双端打开确认

## 附录 E:暂缓清单(原综合草案其余项,2026-09-13 用户裁定暂缓)

> 恢复排期时从原草案恢复任务粒度,此处仅留索引。顺序即原建议优先级。

| 原任务 | 内容 | 暂缓原因(用户视角) |
|---|---|---|
| M1 | 内置联网搜索(博查/Tavily/Bing + 兜底)+ 国内模型一键预设 | 涉外部 API key 与供应商选择 |
| M2 | 附件拖拽/粘贴/最近文件/自动读入 | 改动输入主链路,风险高 |
| M3 | 预装办公技能 + 知识检索 trigram 升级 | 触及 FTS 索引重建 |
| M4 | electron-log / 崩溃捕获 / CI / electron-updater | 涉上报端点与分发渠道决策 |
| M5 | safeStorage / yoloMode 默认值 / 代理 / migration 框架 / 备份 | 触及存量数据与网络栈 |
| M6 | 企业就绪(策略文件/网关/审计扩展/SQLCipher 评估等) | 依赖组织决策 |
