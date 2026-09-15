# PulseMind 方案 —— Office 文件编辑质量提升（调研 + 立项草案）

> **状态**：调研完成（2026-09-16），**待用户裁定**后拆任务排期。本文档前半是竞品调研与现状根因，后半是方案与路线图草案。
> **范围**：「编辑 Office 文件的质量」按三类场景定义——A. 修改用户已有的 docx/xlsx/pptx（格式保留）；B. 新建可交付的 docx/xlsx/pptx（排版/公式/图表质量）；C. 交付体验（预览、文件卡片、版本与修订）。
> **关联文档**：`PLAN-office-export.md`（已立项未实施：docx/xlsx/csv 生成闭环，本方案 P0 前置）；`PLAN-preview-pane.md`（预览面板，D1 裁定 office 延后，本方案 P3 复活其后续路线）。

---

## 一、调研 TL;DR

1. **行业分两个阵营**。套件阵营（WPS 灵犀、Microsoft Copilot、Gemini in Workspace）把 AI 接进自家编辑引擎，格式保留是"天然"的；Agent 阵营（豆包工作台、WorkBuddy、ChatGPT、Claude、Manus/Kimi）靠"文件工具箱 + 校验闭环"在文件层面做编辑——**PulseMind 是 Electron 独立应用，只能走 Agent 阵营**，而豆包/WorkBuddy 已证明该阵营能做出消费者可接受的交付质量。
2. **Agent 阵营质量差距的来源不是模型，是工程**：有没有"结构清单 → 定点修改（保格式）→ 程序化校验 → 视觉自检"这条闭环。Claude 的文档技能包（解包 OOXML 直改 + 修订模式 + postcheck 脚本）是目前公开可得的最佳参照实现。
3. **PulseMind 现状：读链路闭环（markitdown-js），写/编辑链路完全缺失**。最严重的一个洞：`write` 工具对二进制文件无防护，模型用 write 写 `.docx` 会产出"文本内容的假 docx"，无任何告警。编辑已有文件的格式保留能力为零。
4. **技术选型上纯 JS 可行但有一个已知坑**：ExcelJS 往返重写会丢弃它不解析的部件（图表等）；SheetJS 社区版读写都不保样式。业界通行解法——**解包 ZIP、直改 XML、原样回包**——恰好 PulseMind 已有 `adm-zip`，Claude 技能包也是同一路线，可以纯 JS 落地。
5. 结论：**方案 = 文件工具箱（声明式编辑算子）+ 校验闭环（程序化 postcheck + Playwright 渲染自检）+ 预览交付 + 技能包**，全部可在现有架构内实现，无 Python/LibreOffice 硬依赖。

---

## 二、竞品调研

### 2.1 阵营划分

| 阵营 | 产品 | 编辑发生在哪 | 格式保留 | 对 PulseMind 的可借鉴性 |
|---|---|---|---|---|
| 套件内原生 | WPS 灵犀、MS Copilot、Gemini in Workspace | 办公套件自己的编辑引擎/对象模型 | 天然无损（引擎即格式本体） | 架构不可复制（需拥有套件），但其"格式组合识别 + 无损编辑"是质量标杆 |
| Agent + 文件工具箱 | 豆包工作台、WorkBuddy、ChatGPT、Claude、Manus/Kimi | 独立编辑器或程序化文件操作 | 取决于工具箱工程 | **PulseMind 同属此阵营**，架构、UX、质量手段均可对标 |

### 2.2 豆包（字节跳动）

- **对话内生成**：聊天中直接产出 `.docx` 结构，点"导出"生成可下载文件；社区反馈其导出格式在国内 AI 产品里偏稳定（[葡萄城实测推荐豆包原生导出](https://grapecity.csdn.net/69e83cce0a2f6a37c5a1759a.html)、[火山引擎：豆包 word 排版](https://developer.volcengine.com/articles/7606616881075912714)）。也有用户指出并非所有入口都能直接出 docx，存在复制/Markdown 转换的过渡形态（[发现AI问答](https://ask.faxianai.com/2616)）。
- **工作台 · 本地 Office 编辑**（2026 年中上线）：侧边工作台选文件或右键本地文件调起；**当前支持 PPT 与 Excel，Word 官方称"后续上线"**；AI 修改后用户可继续在本地编辑，"保存后的修改结果同步至线上和本地"——即**线上编辑器 + 本地/云端双向同步**路线，不是驱动本机 Office（[雷峰网报道](https://www.leiphone.com/category/industrynews/yxQfJirnLSi8BOoA.html)）。
- **可借鉴**：① 右键/工作台两种入口；② "AI 改完用户接着改"的协同心智（对应我们的版本快照 + 预览）；③ 逐格式灰度上线（先 Excel/PPT 后 Word）说明**没有厂商能一口吃下三种格式的编辑保真**。
- **未公开**：格式保留的具体实现、同步冲突处理。

### 2.3 WorkBuddy（腾讯云 CodeBuddy 团队）

- 定位"AI Agent 办公新范式"：一句话任务 → 自动拆解规划 → 多 Agent 并行 → 交付**可验收的文件产物**（文档/表格/PPT/网页）（[官网](https://www.workbuddy.cn/)、[产品页](https://cloud.tencent.com/product/workbuddy)）。
- 结果区提供**产物、全部文件、变更和预览**四类信息——"变更"即任务过程中对文件的操作记录，这是 Agent 阵营里少见的把"编辑过程"产品化的做法（[文档 Overview](https://www.workbuddy.ai/docs/zh/workbuddy/Overview)）。
- 支持读取授权的本地文件夹做批量处理（重命名、格式转换等）；有技能市场（Skills）与连接器扩展能力；企业版已接入腾讯文档/网盘（[文档站](https://www.workbuddy.ai/docs/zh/workbuddy/Overview)）。
- **可借鉴**：① "产物 + 变更 + 预览"的结果面板三件套；② 任务可验收（交付物而非回复文本）的产品叙事；③ 技能市场承载办公能力扩展——与 PulseMind 既有技能系统同构。
- **未公开**：文档生成的具体工具链（其《文档生成与编辑》实践页无公开技术细节）；格式保留能力无法从外部验证，本次调研不下结论。

### 2.4 套件阵营（质量上限参照）

- **WPS 灵犀**（金山办公，2025 WAIC 发布）：在 WPS 组件内调用时可识别**数千种格式组合**，编辑保留图文混排、复杂表格、多级列表等版式细节，"无需手动二次排版"；官方卖点即"修改可控、格式保留"（[新华社发布报道](http://www.news.cn/finance/20250728/64d6e8901aa74e7ebc6942049d353b16/c.html)、[百度百科](https://baike.baidu.com/item/WPS%E7%81%B5%E7%8A%80/66253146)、[WPS 官网指南](https://www.wps.cn/article/DtUxFpey.html)）。PPT 侧的做法被概括为"实时生成 + 文本框级编辑 + 格式无损"。
- **Microsoft Copilot in Word**：选中内容 → 自然语言要求重写/改写/调整格式，改动直接发生在 Word 文档对象上，天然保留样式，且带 diff 式审阅 UI（[官方说明](https://support.microsoft.com/zh-cn/word/copilot/rewrite-text-with-copilot-in-word)、[Word AI 重写工具页](https://word.cloud.microsoft/create/zh-hans/ai-rewriter/)）。
- **启示**：套件阵营的"无损"来自编辑引擎。Agent 阵营无法复制引擎，但可以复制其**两个 UX 事实标准**：① 文本框/段落级的定点编辑（而不是整篇重排）；② 改动可审阅（diff/修订）。

### 2.5 Agent 阵营的技术路线（公开可查部分）

| 产品 | 路线 | 质量手段 | 公开来源/证据 |
|---|---|---|---|
| ChatGPT | Code Interpreter 沙箱里跑 python-docx/openpyxl/python-pptx | 无视觉自检（历史形态），质量靠模型自觉 | 通用常识，无官方文档，不作重点 |
| **Claude（文档技能包）** | docx：解包 OOXML → 定点改 XML → 回包；修订用 `w:ins/w:del`；xlsx：openpyxl + "活公式保证/零错误容忍/兼容性优先/保留匹配"四原则 + validate 脚本；pptx：python-pptx 文本替换（first-run replace 保格式）+ 文本预算规则 | **程序化 postcheck（14 条规则）+ 强制校验闭环**；模板继承流程（先盘点后动手、`budget = orig_len × 1.1`） | 本次调研直接读到了该技能包全文（docx/pptx/xlsx SKILL.md），是本方案的主要参照架构 |
| Manus / Kimi 等 | PPT 走 HTML 设计稿 → 转 PPTX 的管线；模板化生成 | 设计规范（版式/配色/字体）前置 + 渲染检查 | [html-to-pptx 方案](https://blog.csdn.net/weixin_30652491/article/details/96858298)、[python-pptx 教程](https://www.psvmc.cn/article/2026-03-25-python-pptx-tutorial.html) |
| 通用痛点佐证 | "AI 写完内容，Word 排版要命"——Markdown→Word 的公式/样式/表格丢失是普遍投诉 | —— | [知乎：Python + Pandoc 一键转换](https://zhuanlan.zhihu.com/p/2070823192470480118) |

**Claude 技能包里值得原文照抄的质量规则**（均已在本地技能包中验证存在）：

- 编辑前先**盘点结构**（段落/形状/工作表清单 + 字体字号 + 原文长度），"原文长度就是预算上限"（`budget = orig_len × 1.1`），替换文案先过预算再落盘——这是防溢出的第一道闸。
- docx 修订默认走 **tracked changes**（`<w:del>/<w:ins>` 包裹、保留原 run 属性 `w:rPr`），让用户可审阅。
- xlsx 四原则：派生值一律活公式（交付对象是人时）；公式零错误（除法包 `IFERROR`）；**禁用动态数组函数**（`XLOOKUP/FILTER` 等，兼容老版 Office/WPS）；编辑已有文件时"保留并匹配"既有格式约定，现有模式优先于默认样式。
- pptxgenjs 富文本数组会产生**每个 run 一个 `<a:pPr>`** 的 schema 违规——LibreOffice 能渲染、PowerPoint 打开即"需要修复"。这类坑说明：没有校验闭环的生成管线，质量是碰运气。

### 2.6 JS 生态关键事实（决定我们的选型）

| 事实 | 证据 | 对选型的含义 |
|---|---|---|
| ExcelJS 重写已有 xlsx 会**丢失它不解析的部件（图表等）**——xlsx 是 ZIP 容器，ExcelJS 不读全量 | [腾讯云问答：ExcelJS 图表丢失](https://developer.cloud.tencent.com/ask/sof/107948337)、[Reddit：改 Excel 不丢格式的 JS 库](https://www.reddit.com/r/node/comments/1iwvt43/need_a_javascript_library_to_modify_excel_files/?tl=zh-hans) | 含图表/透视表的文件**不走 ExcelJS 往返**，走 OOXML 直改；或改前特性检测 + 告警 |
| SheetJS 社区版**读不解析样式、写不保样式**（样式是 Pro 付费功能） | [博客园：SheetJS 样式问题](https://www.cnblogs.com/alexgl2008/articles/15919926.html)、[知乎](https://zhuanlan.zhihu.com/p/257845606) | 不选 SheetJS 做编辑通道；`xlsx-js-style` 分支只够"新建加样式" |
| 业界对"改已有文件不丢格式"的通行答案：**解包 → 直改 XML（只动目标节点）→ 原样回包**，图表/样式/主题零触碰 | 同上 Reddit 帖及多家方案 | 与 Claude 技能包路线一致；PulseMind 已有 `adm-zip`，纯 JS 可落地 |
| `docx` npm（生成）+ `exceljs`（新建）为纯 JS、无原生编译 | `PLAN-office-export.md` D1 已裁定 | 沿承，不推翻 |

---

## 三、PulseMind 现状盘点（缺口清单）

> 代码位置均由本次代码库走查确认（2026-09-16，feature_0.4.0 工作树）。

### 3.1 已经有的（复用基础）

| 能力 | 位置 | 说明 |
|---|---|---|
| Office → Markdown 读取 | `src/main/storage/extractors/markitdown-extractor.ts`（`markitdown-js`，纯 JS） | 覆盖 docx/pptx/xlsx/xls/pdf 等 18 种扩展名；带读缓存（`read-cache.ts` `getOrConvert()`） |
| read 工具自动转换 | `tool-executors.ts:99` `CONVERTIBLE_EXTS` → `:165` | 转 markdown 后分页返回；知识库另有一条 fork 子进程的同链路（`knowledge-store.ts:330`） |
| 路径沙箱 | `src/shared/sandbox/path-jail.ts` + `src/main/sandbox/guard.ts` | 读全盘、写锁定会话工作区，所有 svc 读写先过 guard——office 工具直接继承 |
| 技能系统 | `skill-store.ts`（ZIP 整目录导入含 scripts，`:145`）+ `pick_skill` 工具（`tool-executors.ts:357`） | **可以原样承载"office 编辑技能包"**（路由规则/设计规范/检查清单） |
| Playwright Chromium | `browsers/`（浏览器工具已用） | 可复用为 office 产物的**渲染自检**执行器 |
| 多模态回注 | 工具结果截图经 sharp 落盘再进消息（`agent/image-utils.ts`） | 渲染自检的截图有现成通道回到模型眼前 |
| 预览面板骨架 | `components/preview/` + `previewPaneStore.ts` + `HtmlPreview.tsx`（iframe 直挂 `local-file://`） | office 落 fallback 卡是 D1 裁定延后，不是缺机制 |

### 3.2 缺口（按严重度排序）

| # | 缺口 | 位置/证据 | 用户可感知的后果 |
|---|---|---|---|
| G1 | **写/编辑工具对二进制格式零防护** | `file-ops.ts:218` `svcWriteFile` 固定 utf-8；`tool-executors.ts:236` `execWorkspaceTool` | 模型用 write 产出"假 docx"（文本内容、zip 头都没有），静默落盘；用 edit 改二进制会 mojibake 回写**破坏原文件** |
| G2 | **无格式保留编辑能力** | 全库无 OOXML 写路径 | "把第 3 节的结论改成 X""这版合同改下甲方"只能整篇重造，格式全丢 |
| G3 | **无 office 生成工具** | `PLAN-office-export.md` 未实施（无 `office-export.ts`、无 `export_document`，依赖未装） | 交付只给 markdown/CSV，用户手工转换——竞品对标的起点都未达到 |
| G4 | **无质量校验环节** | 无 postcheck/渲染检查任何形式 | 生成质量随机：溢出、占位符残留、公式错误、PowerPoint"需要修复"无人兜底 |
| G5 | **office 预览是 fallback 卡** | `file-kind.ts:15` OFFICE_EXTS → `PreviewContent.tsx:120` `!isPreviewable` | 交付后用户看不到结果，要跳 OS 打开；模型也看不到自己写了什么 |
| G6 | `.doc/.ppt/.xls` 旧格式读不了 | `CONVERTIBLE_EXTS`（`tool-executors.ts:99`）不含 `.doc` | 旧格式 fall through 到 shell cat 输出乱码 |
| G7 | 无版本快照/diff | —— | AI 改坏文件无法一键回退、无法说明改了哪 |

---

## 四、方案设计

### 4.0 设计原则（先立规矩）

1. **纯 JS、无新运行时**：沿承 D1 裁定——不引入 Python/LibreOffice 硬依赖；确需系统级能力（旧格式转换）一律"探测到才用、没有就降级提示"。
2. **声明式算子，不让模型裸写脚本**：编辑以结构化参数（算子 + 定位 + 内容）进主进程服务，XML 操作全部由实现兜底；模型的自由度限制在"选算子、填内容"，不开放"生成操作 XML 的代码"。这是质量与安全的共同下限，也是与 Claude 技能包"让模型写 python 脚本"路线的**刻意分叉**（他们面向开发者终端，我们面向普通用户，且 exec 环境无 Python 保证）。
3. **定点编辑优先于重建**：凡"改已有的文件"，默认格式保留编辑；重建（读出 → 重造）必须作为显式选择并告知代价。对齐套件阵营"文本框级编辑"的体验标准。
4. **没有校验不算完成**：产物必须过程序化 postcheck；关键产物加渲染截图自检。延续本仓库"probe 文化"（面板渲染探针、审批探针的同思想：不能只信源码，要测产物）。
5. **技能承载知识，工具承载能力**：设计规范（版式/配色/字体/场景规则）放技能包（用户可换可装），算子与校验放内置工具（不可被技能绕过）。

### 4.1 架构总览

```
模型决策层（提示词 + office 技能包：路由 create/edit/template，场景规范，检查清单）
        │ 声明式调用
        ▼
内置工具层（renderer/src/tools/built-in-tools.ts + tool-executors.ts）
  office_inspect / office_edit / export_document / office_check / office_render
        │ IPC（沿用 host 桥模式）
        ▼
主进程服务层（src/main/services/office/，新增）
  ├─ inspect.ts   结构清单（段落/形状/工作表 + 样式 + 文本预算）
  ├─ docx-edit.ts OOXML 解包直改（adm-zip）+ 修订模式 + 模板样式继承
  ├─ xlsx-edit.ts exceljs 往返（无图表件）⇄ OOXML 直改（含图表件）+ 公式校验
  ├─ pptx-edit.ts 幻灯片 XML 文本替换（first-run 保格式 + 预算闸）
  ├─ export.ts    docx(x)/xlsx(x)/csv —— 即 PLAN-office-export M1 落点
  └─ check.ts     postcheck 规则集（可打开性/占位符/溢出/公式错误/损坏 rels）
        │ guardFsTarget（既有沙箱 + 审计）
        ▼
校验闭环：check（程序化）→ office_render（Playwright 截图）→ 模型自检 → 修正 → 再检
        ▼
交付层：文件卡片（打开文件夹）+ 预览面板（高保真 HTML 预览）+ 快照/diff（回退与审阅）
```

### 4.2 工具层设计（新增内置工具）

| 工具 | 职责 | 关键参数（示意） | 质量要点 |
|---|---|---|---|
| `office_inspect` | 产出结构清单：docx 段落/表格树（样式、文本长度）、xlsx 工作表/used-range/公式/图表清单、pptx 每页形状清单（位置/字号/原文长度） | `path`，`scope` | **预算闸的输入**：原文长度×1.1 即替换文案上限；大文件分页返回控 token |
| `office_edit` | 定点编辑（格式保留），算子式 | `path, ops[]`；算子：`replace_text`（docx/pptx，first-run 保属性）、`delete_paragraph`、`insert_paragraph`、`set_cell`、`add_row`、`delete_slide`、`add_comment`、`track_changes` 开关 | 只动目标节点；docx 修订默认开（`w:del/w:ins`），保持可审阅 |
| `export_document` | 新建 docx/xlsx/csv（= PLAN-office-export 全部里程碑，不重复设计） | 沿用该文档 D2–D7 决策 | markdown 映射规则表（该文档附录 A） |
| `office_check` | postcheck：重新打开验证（zip/XML 合法、rels 完整）、占位符残留（xxx/TODO/lorem）、溢出（清单预算比对）、xlsx 公式错误与函数兼容性扫描、pptx 文本预算复核 | `path` | 规则集先抄 Claude 技能包 14 条并本地化为 JS；结果结构化返回，模型可读可修 |
| `office_render` | 渲染自检：docx→HTML（`docx-preview`）、xlsx→HTML 表格（exceljs 导出）、pptx→程序化版式近似图；Playwright 截图 → 图片进工具结果 | `path` | 给模型"眼睛"；沿用浏览器工具的 Chromium，无新增运行时 |

**write/edit 守卫（G1，最先做、成本最低收益最大）**：`svcWriteFile`/`svcEditFile` 落盘前做扩展名 + magic-byte 检查（`PK\x03\x04` 等），对二进制扩展名直接拒绝并返回引导话术："该文件是 Office/二进制格式，请改用 `export_document` / `office_edit`"。同时把 `.doc/.ppt/.xls` 补进读转换探测（G6：markitdown-js 若不支持旧格式则明确报错引导转换，而不是 cat 乱码）。

### 4.3 各格式编辑实现要点

- **docx**：`adm-zip` 解包 → 定位 `word/document.xml` 目标节点（文本匹配 + 序号定位，见 `office_inspect` 给出的 id）→ first-run replace（保留 `w:rPr`）→ 回包（`[Content_Types].xml` 首条目、无目录条目、DEFLATED——Claude 技能包的回包规则）。修订模式：原文包 `<w:del><w:r>{rPr}<w:delText>`、新文包 `<w:ins>`，用户在 Word/WPS 里审阅。模板样式继承：解包模板提 `styles.xml`/`numbering.xml` 注入目标文档。
- **xlsx**：先特性检测（有无 `xl/charts/`、pivotTable 部件）。无图表件 → ExcelJS 载入改存（单元格样式保留良好）；有图表件 → OOXML 直改 `sheetN.xml` 单元格，图表/样式零触碰。公式：编辑后用公式引擎重算校验（选型见风险 R4：`formula.js`(MIT) / `fast-formula-parser`(MIT)，HyperFormula 因 GPLv3 双许可**不默认引入**）；校验原则抄 xlsx 技能包四原则（活公式、IFERROR、禁动态数组、保留匹配）。
- **pptx**：v1 只做文本级编辑与删除/重排页：`office_inspect` 产出每形状预算（`budget = orig_len × 1.1`），`office_edit.replace_text` 走 slide XML first-run replace；软换行 `\x0b` 归一化后匹配；短 token（"01"/"%"）按页作用域映射防串改。生成侧若做（P4 裁定），pptxgenjs + 设计规范技能 + 富文本 `<a:pPr>` 陷阱规避。
- **旧格式（.doc/.ppt/.xls）**：v1 不做编辑；检测到时给明确降级话术（提示另存为新格式）。探测到本机 LibreOffice/Office CLI 时可选自动转换（纯加分项，非依赖）。

### 4.4 校验闭环（G4）

两级检查，全部产物强制过第 1 级：

1. **程序化 postcheck（`office_check`）**：可打开性（zip 结构 + XML parse + rels 完整性）、占位符残留、文本预算/溢出、xlsx 公式错误与兼容函数扫描、docx 空页/分节异常（规则本地化自 Claude 技能包 14 条）。结构化错误返回，模型自行修复后重检。
2. **渲染自检（`office_render`）**：预览 HTML + Playwright 截图回注模型，多模态模型自查版式（溢出/遮挡/字体异常）。pptx 无高保真渲染器，退化为"程序化版式检查 + 生成时同步产出 HTML 设计稿"对照。
3. **人工验收保留仓库惯例**：MS Office 与 WPS 双端打开确认写入每里程碑验收条款。

### 4.5 预览与交付（G5/G7）

- **预览面板复活 D1 后续路线**（`PLAN-preview-pane.md:81` 已有蓝本）：① markitdown markdown 预览（链路已在桥上，改 `isPreviewable` 放行即可，成本最低）；② 高保真预览：docx 用 `docx-preview`（MIT）渲染进既有 `HtmlPreview` iframe 通道；xlsx 用 exceljs → HTML 表格（保留样式）；pptx 用近似版式页。
- **文件卡片**：`export_document`/`office_edit` 成功结果渲染卡片（文件名/大小/缩略 + 打开所在文件夹 + 在预览面板打开）——PLAN-office-export M2.3 已有设计，扩展到编辑工具。
- **快照与 diff**：`office_edit` 首次修改某文件前，快照原件到会话工作区 `.versions/`；工具结果附变更摘要（哪些算子命中了哪些节点）；docx 修订模式下 diff 由 Word/WPS 原生呈现，非修订模式给"改前 markitdown 文本 vs 改后"的文本 diff。

### 4.6 技能包与提示词

- **内置 office 技能包**（走既有 `ensureBuiltInSkills` 落盘机制，ZIP 结构兼容技能市场）：`SKILL.md` 只做**路由 + 规则索引**（编辑 or 重建 or 模板继承的决策树、何时必须 tracked changes、何时跑 office_render），场景规范（报告/合同/简历/公文、PPT 版式与 CJK 字体规则、xlsx 四原则）放分文档——控制常驻 token，按需 `pick_skill`。
- **系统提示词**：工具区补一句路由导引（对应 PLAN-office-export M3.1）："交付 Office 文件用 `export_document`；用户给了文件要改，用 `office_inspect` + `office_edit`，禁止用 write 碰二进制"。
- **技能脚本策略**：技能包不携带必须执行环境的脚本；一切能力走内置工具。技能里的"脚本"仅作为展示性参考（PulseMind 打包环境无 Python/node PATH 保证，这是与 Claude 技能包的另一处刻意分叉）。

### 4.7 编辑策略决策树（写进技能包与工具描述）

```
用户诉求涉及 .docx/.xlsx/.pptx 文件？
├─ 文件已存在（附件/工作区）且要求"改"？
│   ├─ 改动可表达为算子（改文字/数字/删段/加行/批注）→ office_inspect → office_edit（docx 默认修订模式）
│   ├─ 含图表/透视表 → xlsx 走 OOXML 直改通道（自动）
│   └─ 要求重排版/重写大半 → 明示"将重建、原格式不保留"，快照后 export_document
├─ 无文件，要求"做一个" → export_document（v1: docx/xlsx/csv；pptx 见 P4 裁定）
└─ 提供了模板 → 模板继承流程（先 inspect 模板样式 → 继承样式再填内容）
```

---

## 五、路线图草案

> 依赖关系：P0 即 `PLAN-office-export.md` 原计划（M0–M4 照单执行，不重复展开）。P1 起为本方案增量。每阶段保持"中间态可发布"。

| 阶段 | 内容 | 前置 | 对应缺口 |
|---|---|---|---|
| **P0 生成闭环** | `PLAN-office-export.md` M0–M4 全量：exceljs+docx+marked、`export_document`、文件卡片、双端验收 | 无 | G3 |
| **P1 守卫与盘点** | write/edit 二进制守卫（magic-byte）；`.doc/.ppt/.xls` 读降级话术；`office_inspect`（三格式结构清单 + 预算） | P0 依赖已装（adm-zip 已有） | G1、G6 |
| **P2 编辑闭环 v1** | `office_edit`（算子集 v1：replace_text/delete_paragraph/insert_paragraph/set_cell/add_row/delete_slide/add_comment）+ 快照机制 + docx 修订模式；xlsx 特性检测分流（exceljs 往返 vs OOXML 直改） | P1 | G2、G7 |
| **P3 校验闭环** | `office_check` 规则集（本地化 14 条）；`office_render`（docx-preview + Playwright 截图回注）；预览面板 office ①②（markitdown 预览 + docx/xlsx 高保真） | P2（渲染可提前并行） | G4、G5 |
| **P4 生成扩展 + 技能包** | pptx 生成裁定落地（pptxgenjs + 设计规范技能）；office 内置技能包（路由 + 场景规范 + 检查清单）；模板继承流程 | P3 | 质量上限 |
| **P5 远期评估（需裁定）** | 公式引擎选型落地；`Univer`（Apache-2.0）/OnlyOffice（AGPL）嵌入做原生级 xlsx 预览与编辑的评估；PDF 输出；企业模板库 | P4 | — |

**验收指标（每阶段通用底线）**：产物在 Microsoft Office 与 WPS 双端正常打开；编辑类任务对"未被触及的部件"逐字节不变（解包 diff 断言，进 vitest）；预算闸拦截所有超预算替换；postcheck 无 ❌ 才允许收尾；一次人工越权路径尝试被沙箱拒绝（沿仓库惯例）。

---

## 六、风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | ExcelJS 往返丢图表/透视表等未解析部件 | 编辑含图表工作簿后图表消失 | 特性检测强制分流 OOXML 直改；vitest 断言未触及部件逐字节不变 |
| R2 | OOXML 直改的实现复杂度（rels/Content_Types/回包顺序） | 写坏文件 | 回包规则固化在服务内（不让模型碰 XML）；`office_check` 可打开性为必过项；快照兜底可回退 |
| R3 | 公式重算保真度（JS 引擎函数覆盖不全） | 校验误报/漏报 | MIT 引擎（formula.js/fast-formula-parser）仅做"校验器"不做改写；覆盖不了的函数显式跳过并声明 |
| R4 | CJK 字体/版式在打开端替换 | 观感偏差 | 沿 PLAN-office-export R2 验收口径（WPS+Office 双端）；技能包写明字体选择规则（微软雅黑/苹方优先） |
| R5 | pptx 无高保真渲染，视觉自检缺位 | pptx 质量靠程序化规则 | v1 限定文本级编辑 + 预算闸；生成场景同步产出 HTML 设计稿对照；P5 评估渲染方案 |
| R6 | 模型不选新工具、仍用 write/edit 硬写 | G1 复发 | 守卫是硬拒绝不是提示；系统提示词路由导引；`office_check` 兜底 |
| R7 | 结构清单撑大上下文（大文档） | token 成本 | inspect 分页 + scope 参数；xlsx 只回 used-range 摘要 |
| R8 | 与既有 `PLAN-office-export.md` 的范围重叠 | 双计划冲突 | P0 即该计划原文；本方案 P1+ 为其增量，不改动其已定决策 |

## 七、待用户裁定

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | PPT 生成是否解禁（PLAN-office-export D2 曾裁定 v1 不做 pptx） | P4 做，用 pptxgenjs + 设计规范技能；若维持禁令则 office 范围=Word/Excel |
| Q2 | docx 修订模式是否默认开启 | 默认开（可审阅是套件阵营的 UX 事实标准）；用户说"直接改好"时关 |
| Q3 | 公式引擎选型（MIT 的 formula.js / fast-formula-parser，还是引 HyperFormula 商业许可） | formula.js（MIT，函数覆盖广，仅作校验） |
| Q4 | P5 是否立项评估 Univer/OnlyOffice 嵌入 | 先不立项；P3 高保真预览落地后按反馈决定 |
| Q5 | 预览面板 D1 是否随 P3 复活（含 ① markitdown 预览提前到 P1 的可能性） | ① 可提前到 P1（成本极低），② 随 P3 |

## 附录：参考来源

- 豆包：[雷峰网：豆包工作新增本地 Office 编辑](https://www.leiphone.com/category/industrynews/yxQfJirnLSi8BOoA.html)、[葡萄城：AI 生成标准 Word 文档实测](https://grapecity.csdn.net/69e83cce0a2f6a37c5a1759a.html)、[火山引擎：豆包 word 排版](https://developer.volcengine.com/articles/7606616881075912714)、[发现AI：豆包生成 word 现状](https://ask.faxianai.com/2616)
- WorkBuddy：[官网](https://www.workbuddy.cn/)、[腾讯云产品页](https://cloud.tencent.com/product/workbuddy)、[文档 Overview](https://www.workbuddy.ai/docs/zh/workbuddy/Overview)、[CodeBuddy 关联页](https://www.codebuddy.cn/work/)
- WPS 灵犀：[新华社：WAIC 2025 发布](http://www.news.cn/finance/20250728/64d6e8901aa74e7ebc6942049d353b16/c.html)、[百度百科](https://baike.baidu.com/item/WPS%E7%81%B5%E7%8A%80/66253146)、[WPS 官网指南](https://www.wps.cn/article/DtUxFpey.html)
- Microsoft Copilot：[Rewrite with Copilot 支持页](https://support.microsoft.com/zh-cn/word/copilot/rewrite-text-with-copilot-in-word)、[Word AI 重写工具](https://word.cloud.microsoft/create/zh-hans/ai-rewriter/)
- JS 生态：[ExcelJS 图表丢失问答](https://developer.cloud.tencent.com/ask/sof/107948337)、[Reddit：修改 Excel 不丢格式的 JS 库](https://www.reddit.com/r/node/comments/1iwvt43/need_a_javascript_library_to_modify_excel_files/?tl=zh-hans)、[SheetJS 样式问题](https://www.cnblogs.com/alexgl2008/articles/15919926.html)、[xlsx-js-style](https://gitbrent.github.io/xlsx-js-style/)
- 行业管线与痛点：[html-to-pptx 方案](https://blog.csdn.net/weixin_30652491/article/details/96858298)、[python-pptx 教程](https://www.psvmc.cn/article/2026-03-25-python-pptx-tutorial.html)、[知乎：AI 写完内容 Word 排版要命](https://zhuanlan.zhihu.com/p/2070823192470480118)
- 参照实现：Anthropic/Z.AI 文档技能包 docx/pptx/xlsx（本地 `document-skills` 插件，SKILL.md + routes/edit.md 全文已核）
