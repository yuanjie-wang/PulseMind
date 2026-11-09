/**
 * The office skill's routing half — the body of its SKILL.md (see
 * built-in-skills.ts for the registry entry and office-references.ts for the
 * per-format rule sets it points at).
 *
 * It deliberately does NOT restate the per-tool op lists. Each tool's manual
 * (tool-instructions.ts) ships in every request and already documents its
 * operators, parameters and refusals; a second copy here would be one more
 * thing to keep in sync — the exact failure mode that retired the `browser_use`
 * skill. What lives here is what the manuals cannot carry: how to choose
 * between generating and editing, the recipes that cross that boundary, and
 * the pre-delivery self-check.
 */
export const OFFICE_SKILL_PROMPT = `## Active Skill: Office Deliverables

交付真实的 Office 文件（Word / Excel / PPT / PDF）：从零生成、修改已有文件、按模板填充。

**本技能不重复算子清单。** \`office_export\` / \`office_edit\` / \`office_inspect\` / \`office_read\` 各自的工具手册随每次请求下发，算子、参数、拒绝条件是那里的唯一权威。本技能只补手册没有的东西：**生成与编辑之间怎么选**、跨两者的配方、交付前的自检。

### 1. 先判定任务形状

用户诉求落在哪一格，决定走哪条路线：

- **改已有文件**（附件或工作区里的 .docx/.xlsx/.pptx）→ **编辑路线**：\`office_inspect\` 拿清单与文本预算 → 需要精确原文 / 单元格值 / shape 全文时 \`office_read\` 分页精读 → \`office_edit\`。docx / pptx 字节保真（未触及的部件逐字节不变）；xlsx 保格式保值但整簿重写（exceljs）。
- **从零做一个**（"给我一份""整理成 Excel"）→ **生成路线**：\`office_export\`（Word / Excel / PDF 用 content 或 sourcePath）。**从零做一个 PPT 一律走设计路线**（下一格）。
- **从零做一个 PPT**（无论有没有明说设计要求）→ **设计路线**：**先对齐风格、落定 tokens.css，再写 HTML**——①给用户 1–3 个风格方向（主色/辅色/明暗/字体/气质，用具体 hex 与场景理由；用户说不清就用方向对比帮他说清，给了明确品牌色就复述确认），②确认后 \`write\` tokens.css 落定主题——**tokens 即锁**，之后改风格只改它；不要跳过对齐自作主张套默认主题。③写 deck.html（受限 HTML profile，每页一个 960×540 的 .slide），④\`office_export\`（format pptx + \`htmlPath\`）。用户明确只要纯文字大纲页时才退 markdown content（兜底）。**profile 与流程全文见 \`references/pptx.md\` 设计路线节**。
- **用户给了模板要套**（公司 PPT 模板、合同模板）→ **模板继承**：先 \`office_inspect\` 看结构，再用编辑工具逐形状 / 逐段填入内容。**不要**用 \`office_export\` 重建——那会丢掉模板的母版与样式，而模板的价值全在那里。
- **格式转换**（docx→PDF、CSV→xlsx）→ \`office_export\`：\`sourcePath\` 指已有文件，或 \`content\` 给内容。
- **只是要看内容 / 做总结** → \`read\`（自动转 markdown）。要**编辑定位**——精确段落原文、10×10 头部预览之外的单元格值、某形状的全文与 shape id——走 \`office_read\`：它给的是编辑工具消费的坐标（段落索引 / 单元格地址 / shape id），\`read\` 的 markdown 是重排过的，抄进 replace_text 会错位。

两条路线的结果完全不同（一个保留原格式，一个重新排版）。判断不清时问一句："你是要改这份，还是要一份新的？"

### 2. 铁律

1. **绝不用 \`write\` / \`edit\` 碰 Office 二进制。** 它们会被硬拒绝——这不是阻碍，是在保护文件不被 UTF-8 覆写成乱码。同理不要用 \`exec\` 跑 python-docx / python-pptx / libreoffice：那绕开了路径沙箱、备份与回读门禁，也没有预览联动。
2. **改已有文件，永远先 \`office_inspect\`。** 拿到段落 / 形状 / 工作表清单和文本预算再动手；跳过这一步的失败模式是把不该改的地方也改了。反过来，只是读内容 / 做总结时**不要**先 inspect——那是编辑前的 triage（结构清单 + 头部预览，不含全文），读全文走 \`read\`。
3. **遵守文本预算。** \`office_inspect\` 会把 docx 的文本预算（原文长度 × 1.1）直接算给你，那就是替换文案的上限；PPT 没有现成的预算字段，但 \`office_read\` 给出的原文本身就是标尺。超了会溢出——PPT 的文本框不会自动重排，Excel 的长文本会顶到隔壁单元格。
4. **Word 的改动默认带修订。** \`replace_text\` 传 \`track_changes: true\`，用户在 Word / WPS 里能逐条接受或拒绝，这是可审阅的底线。只有用户明确说"直接改好、不要留痕"时才关掉。
5. **能力边界当面说清，不做静默降级。** 做不到的事（页眉页脚、目录、图表、增删列、含图表的工作簿）如实告知并给可行的替代方案，而不是悄悄丢内容。
6. **一次给一批算子。** \`office_edit\` 的批次是原子的——任何一条失败整批不写盘。索引随批次内前面的算子变化，按你的意图排好顺序。

### 3. 三条配方（手册里没有、但最常用）

**A. 表格：先生成值，再补格式与公式。**
生成端不产任何样式与公式（详见 \`references/xlsx.md\`）。所以标准两步是：
1. \`office_export\`（format xlsx）把数据落成表——类型已经正确，前导零会按意图留在文本；
2. \`office_edit\` 用 \`set_cell\` 给需要的单元格补 \`number_format\`（如 \`0.00%\`、\`yyyy-mm-dd\`）或 \`formula\`（派生值用活公式）。
先 \`inspect\` 一次拿 used range，再按列批量给算子。

**B. 模板填充：只换文本，别动样式。**
- PPT：\`office_read\`（slide=N 按页）拿每页 shape_id → \`office_edit\` \`set_shape_text\` 逐形状重写。段落样式继承自母版，**不要**顺手 \`format_text\` 覆盖字体字号。
- Word：\`office_read\` 拿段落索引与精确原文 → \`office_edit\` \`replace_text\` 定点替换。
- 新内容比占位符长很多时，先按铁律 3 的数字判断要不要换页 / 加页，再落笔。

**C. 生成后微调结构。**
生成端表达不了的版式用编辑补：
- 需要"封面 / 落款"这类独立段落 → \`office_edit\` \`insert_paragraph\` + \`set_paragraph_style\`（样式名如 \`Heading1\`）。
- 需要调整位置尺寸（PPT）→ \`office_edit\` \`set_shape_geometry\`（单位英寸）。
- 补不了的（页眉页脚、页码、目录）就直说，别硬凑；插图给工作区图片路径（png/jpg/jpeg/gif）即可嵌入，网络图 v1 不嵌。

### 4. 交付前自检

产物落盘后、收尾前过一遍——这些正是用户第一眼会看的：

- **产物本身**：路径存在、大小非零。工具已做结构性回读，失败会整批拒绝，所以走到这里说明文件能打开。
- **占位符残留**：搜一遍 \`TODO\`、\`xxx\`、\`待填\`、\`lorem\`、\`{{\`、\`[图片\`——生成端的降级声明会以文末一行说明出现，确认它确实在、且你已在回复里提过。
- **降级项**：图片、公式、脚注、内嵌 HTML 这类被降级的内容，有没有在回复里如实说明？
- **数字与格式**：表头字段名是否自解释；百分比 / 日期要不要 \`number_format\`；公式有没有 \`#REF!\` / \`#DIV/0!\` 风险（除法包 \`IFERROR\`）。
- **长度**：有没有超预算的替换、有没有一页塞七八条要点。
- **设计路线（htmlPath）**：保真报告里的降级项已在回复里如实说明；deck.html / tokens.css 留在工作区并在回复里告知（用户改版式的入口）；改过 HTML 重新导出前，确认没有丢掉用户在 pptx 上做过的 office_edit 修改。
- **交付指引**：\`office_export\` 会自动在预览面板打开产物——用户关心的重点如果在里面，指给他看。

自检发现的问题，能修就修一轮再交付；修不了的写进回复说明，不要沉默交付。

### 5. 参考文档

按任务所属格式读一份。三个文件都放在本技能自己的目录下：\`pick_skill\` 的返回里带有本技能 SKILL.md 的绝对路径（**Location** 一行），取其所在目录拼 \`references/\` 下的文件名即可；万一那条缺失，用系统提示环境信息里的 \`Skills Directory\` 根目录拼 \`office/references/…\`。用 \`read\` 工具读取：

| 文件 | 什么时候读 |
|---|---|
| \`references/docx.md\` | 出 Word：报告 / 公文 / 合同 / 简历各自的版式规范、markdown 能表达与不能表达什么、编辑要点 |
| \`references/xlsx.md\` | 出 Excel：四条公式原则、表结构与类型规范、生成端的边界、编辑要点 |
| \`references/pptx.md\` | 出 PPT：设计路线全文（风格对齐 → tokens.css → deck.html 的 profile 与图表标注）、每页信息量、配色与字号、模板填充与文本预算 |

只有需要判断"这份交付该长什么样"时才读；一次性的小任务不必读。`
// The prompt MUST NOT end with a trailing newline — same round-trip rule as
// browser.ts: formatSkillMd writes it, parseSkillMarkdown trims it off, and
// the provenance signature never closes (2026-11-04, see skill-parser's
// skillProvenanceMatches).
