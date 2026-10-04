/**
 * The office skill's per-format rule sets — the files SKILL.md names but does
 * not inline, seeded to `~/.pulsemind/skills/office/references/` by
 * ensureBuiltInSkills so the `read` tool can reach them (pick_skill only ever
 * returns the SKILL.md body).
 *
 * Every claim here is checked against the implementation, because a rule set
 * that promises more than the engine does is worse than no rule set:
 *   - markdown → docx mapping: office-export/md-to-docx.ts (only code runs get
 *     a face; fonts are never chosen — the one document-level control is the
 *     export_document `fontSize`, which scales body/headings/code together)
 *   - markdown → xlsx: office-export/md-tables.ts + cell-type.ts (a bare grid —
 *     no styles, no formulas)
 *   - markdown → pptx: office-export/md-to-pptx.ts (slide limit 200, bullet
 *     level capped at 2, one table per page, fixed 16:9)
 *   - deck spec → pptx: office-export/deck-to-pptx.ts (9 layouts, vector-shape
 *     charts, accent theme; the model picks layouts, never coordinates)
 *   - edit operators and refusals: shared/office/ops.ts + each tool's manual
 *   - pptx `format_text` font writes BOTH a:latin and a:ea (pptx/ops.ts), so a
 *     CJK face name takes effect on Chinese text — that is why the recipe below
 *     can promise it.
 */

export const OFFICE_SKILL_REFERENCES: Record<string, string> = {
  'references/docx.md': `# Word 交付规范（docx）

生成走 \`export_document\`（format docx，输入 markdown）；改已有文件走 \`office_edit\`。

## 一、版式只能用 markdown 表达

生成端是 markdown → docx 的固定映射，你能控制的版式就是这张表：

| markdown | 落到 docx 上 |
|---|---|
| \`#\` – \`######\` | Heading1 – Heading6 |
| 空行分段 | 独立段落 |
| \`**粗**\` \`*斜*\` \`~~删~~\`、以及用反引号包住的代码 | 加粗 / 斜体 / 删除线 / 等宽 |
| \`[文字](url)\` | 超链接 |
| \`![alt](workspace/图片.png)\` | 正文行内图片（工作区路径，png/jpg/jpeg/gif；宽上限 600px 等比缩） |
| 无序 / 有序列表 | 项目符号 / 编号，嵌套 ≤3 层（更深会被拍平） |
| 表格 | 表格（表头行加粗带底纹） |
| 代码块 | 等宽 + 浅灰底纹的段落，无语法高亮 |
| \`>\` 引用 | 缩进 + 左边框段落 |
| \`---\` | 水平分隔线 |

行内样式只取**最外层**一层：\`***加粗且斜体***\` 只落加粗或斜体中的一层，不会组合成两者兼有。这是既定的保真口径，不是 bug。

整份文档的字号用 \`export_document\` 的 \`fontSize\`（磅，6–72 可带 0.5：10.5=五号、12=小四、14=四号、16=三号）：它设的是**正文基准**，标题与代码块按同一比例缩放，层级不塌（不给就是 Word 默认 11 磅）。要让某一两处不一样：先导出，再用 \`office_edit\` 的 \`format_text\` 带 \`font_size\` 单点改。

## 二、表达不了的（别硬凑，如实说）

- **封面页、页眉页脚、页码、目录**：生成端没有这些概念。
- **插入图片（网络/内联地址）**：\`http(s)://\` 与 \`data:\` 的图片不嵌图，保持占位文字（形如 \`[图片:xxx.png,正文不支持]\`）——工作区里的图片文件才会真正嵌入。
- **公式、脚注、内嵌 HTML**：原文照抄 + 文末一行说明。
- **字体与局部字号**：字体从不指定，Word / WPS 按自己的默认样式渲染（CJK 由打开端替换；只有代码块固定等宽 Courier New）。字号只有 \`fontSize\` 这一个全文基准，**没有逐段字号**——逐段的先导出，再用 \`office_edit\` 的 \`format_text\` 改。
- **首行缩进、行距、分节、页面设置**：无。

用户明确要封面 / 页眉页脚 / 页码时：告诉他生成端做不到，但可以用 \`office_edit\` 补一个封面段落，其余的建议他在 Word 里手动加一次（加完就是模板，之后可复用）。

## 三、四种高频场景的结构

**报告 / 调研**
\`\`\`
# 标题（一句话说清结论方向）
（摘要段：结论先行，2–4 句）
## 一、背景
## 二、发现      ← 数据一律进表格，不要用长句罗列数字
## 三、结论与建议
\`\`\`

**公文**
- \`#\` 标题；正文用普通段落（首行缩进设不了，别假装有）。
- 落款（单位、日期）各占一个独立段落。
- 不用引用块、分隔线、emoji 这类装饰元素——正式文种里它们不合适。

**合同 / 协议**
- 条款用有序列表 \`1.\` \`2.\`，层级不超过 3 层。
- 关键条款、待填空处用 \`**加粗**\` 标出，让用户一眼看到。
- 金额写清币种与单位（"人民币 12,000 元"），不要只写数字。
- 需要用户填的空用 \`____\` 或 \`【】\`，并在回复里列出"需要你确认的空有哪几处"。

**简历**
- \`#\` 姓名 → 下一行放联系方式（一条段落，用 \` | \` 分隔）→ \`##\` 分板块（工作经历 / 项目 / 教育 / 技能）。
- 每段经历用 \`###\` 或加粗行写"公司 · 职位 · 时间"，下面用无序列表列成果；成果尽量带数字。
- 日期写成文本（如 \`2024.03 — 2026.09\`）。不能右对齐，也别指望。

## 四、编辑要点（office_edit·docx）

- **先 \`outline\`**：拿段落索引 + 样式 + 文本长度。索引是后续 op 的定位依据。
- **索引随批次变化**：同一批里前面的 \`insert_paragraph\` / \`delete_paragraph\` 会改变后面段落的编号。按你对最终形态的意图排列顺序。
- **\`replace_text\` 默认要求恰好命中 1 处**，命中数不符整批拒绝。多处的用 \`expected_count\` 或 \`paragraph\` 收窄——不要靠"反正会改第一处"。
- **表格能改文字，也能加行删行**：\`insert_table_row\`（\`after_row\` 后插，可带每格文字，克隆锚点行的边框列宽）/ \`delete_table_row\`。护栏会拒绝竖向合并（vMerge）、嵌套表和删最后一行——撞上就如实说明并给替代。**加列 / 删列做不到**：要加列就加在末尾，或重出一张表。
- **页眉页脚、页码、目录、域不在范围内**——工具手册已列明，遇到就如实拒绝。**图片可以插**：\`insert_image\` 给工作区路径（png/jpg/jpeg/gif，宽上限 600px 等比缩），http(s) / data: 地址嵌不了。
- **修订模式**（\`track_changes: true\`）是给"改用户已有的正式文件"用的，让改动可审阅；你自己刚生成的一份新稿子没必要留痕。
`,

  'references/xlsx.md': `# Excel 交付规范（xlsx）

生成走 \`export_document\`（format xlsx，输入 markdown 表格）；改已有文件走 \`office_edit\`。

## 一、四条公式原则

生成端**不产任何公式**。需要公式时用 \`office_edit\` 的 \`set_cell\` 补——补的时候守住这四条：

1. **派生值用活公式。** 交付给用户看和改的表，合计、占比、差额要写成公式而不是算好的数字；用户改一行，全表跟着变，这才是表格该有的样子。
2. **公式零错误容忍。** 除法一律包 \`IFERROR\`（如 \`=IFERROR(B2/C2,"")\`）；引用的区域不要把可能为空的单元格算进去。
3. **禁用动态数组函数。** \`XLOOKUP\` / \`FILTER\` / \`UNIQUE\` / \`SORT\` / \`SEQUENCE\` 在老版 Office 与部分 WPS 上打不开或报错。改用 \`INDEX+MATCH\`、\`VLOOKUP\`、\`SUMPRODUCT\`。
4. **编辑已有表时保留既有约定。** 原表的数字格式、列顺序、字段命名优先于你的默认偏好；不要顺手"规范化"用户已经习惯的写法。

## 二、表结构规范

- **一表一 sheet。** 不要把两张表堆进一个 sheet。
- **sheet 命名**：markdown 里 \`## 标题\` 开一张以该标题命名的 sheet。名字上限 31 字符，不能含 \`[ ] : * ? / \\\`，重名会自动加 \`-2\`。
- **首行是字段名**，字段名要自解释。单位写进字段名：\`金额(元)\`、\`比率(%)\`——别让用户猜。
- **不要合并单元格。** 生成端表达不了；就算手动加了，合并会让公式引用、筛选、排序全部失效。
- **口径写清**：同比还是环比、含税还是不含税、统计区间——放字段名或表注里。

## 三、类型规则

- 只有**严格往返**才转数值：\`123\` 是数字，\`007\`、\`13800138000\`、\`310101199001011234\`、\`2026001\` 保持文本。
  **这是有意为之，不是缺陷**——工号、手机号、身份证、订单号一旦变成数字就会丢前导零或被科学计数法截断。
- **日期保持文本**（如 \`2026-09\`）。要真日期得用 \`office_edit set_cell\` 写日期序列值 + \`number_format: "yyyy-mm-dd"\`，多一步，但能被排序和做差值。
- 空值统一口径：留空 / \`0\` / \`—\` 选一个，全表一致。

## 四、生成端的边界（如实告知）

- **无样式**：表头不加粗、无底纹、无边框、无列宽、无冻结窗格、无条件格式。产物是干净的值网格。
- **无公式、无图表、无透视表。**
- **csv 只导第一张表**，带 UTF-8 BOM（防 WPS / Excel 中文乱码）。
- 内容超 100KB 时先 \`write\` 成 .md 再走 \`sourcePath\`。

需要格式时的做法就是配方 A：生成 → \`office_edit\` 按列补 \`number_format\`。其余样式（加粗、底纹、颜色、对齐、列宽、冻结窗格）用 \`set_style\` / \`set_column_width\` / \`freeze_panes\` 一批补齐——生成端已自带表头加粗与自适应列宽。含图表/绘图/主题的工作簿上样式算子会被拒绝（如实说明）。

## 五、编辑要点（office_edit·xlsx）

- **先 \`inspect\`** 拿 sheet 名与 used range，再按列批量给算子。
- **含图表、透视表、VBA 的工作簿会被直接拒绝**（引擎无法保真它们）。这时不要硬试：如实说明，给两个替代——另建一张只含数据的表（\`export_document\`），或请用户在原文件里手动改这几格。
- **不支持增删列。** 插列会让既有公式的引用整体错位，所以设计上拒绝；要加列就加在末尾，或重出一张表。
- **样式算子（\`set_style\`/\`set_column_width\`/\`freeze_panes\`）**：颜色一律 6 位 RRGGBB 不带 #；单次 \`set_style\` 展开上限 5 万格；含图表/绘图/主题的工作簿会拒绝这三个算子。生成端已带表头加粗与列宽，通常只需补差异。
- **\`find_replace\` 只改值**：\`include_formulas: true\` 也只替换公式单元格里缓存的**结果文本**，公式表达式本身绝不被改写。富文本 / 超链接单元格命中会被拒（整格替换会毁掉格式）。
- **\`add_row\` 会下移既有行**（\`after_row\` 是 0-based），公式引用不会自动重定向——插完检查一遍受影响的公式。
- 每次写入都会读回校验，静默偏差会整批拒绝。
`,

  'references/pptx.md': `# PPT 交付规范（pptx）

生成走 \`export_document\`（format pptx）：**默认给结构化 \`deck\`**（版式化生成，有设计感），纯文字大纲也可以给 markdown \`content\`（堆文字的兜底）。改已有文件或套模板走 \`office_edit\`。

## 一、deck：版式化生成（默认路线）

deck 是一个 JSON 对象：\`{ title, theme?: { accent }, slides: [...] }\`。**你选版式、填内容；排版、配色、图表全部由引擎完成**——你给出的不是坐标和字号，而是「这一页是什么类型的页」。

| layout | 用途 | 必填槽位 |
|---|---|---|
| \`cover\` | 封面 | title（+subtitle） |
| \`section\` | 章节隔页（整页浅色底） | title（+subtitle） |
| \`bullets\` | 要点页 | title + bullets（1–10 条，字符串或 {text, sub:[…]}） |
| \`two-col\` | 双栏对比 | title + columns=[{heading, bullets}, {heading, bullets}] |
| \`kpi\` | 大数字卡 | title + items=[{value, label}]（2–4 个） |
| \`chart\` | 图表页 | title + chart={type, categories, series} |
| \`table\` | 表格页 | title + header + rows（≤12 行） |
| \`quote\` | 引用页 | quote（+author） |
| \`image\` | 图片页 | image=工作区图片路径（png/jpg/gif；caption、bullets 可选，有 bullets 时图左文右） |

图表 \`chart\`：\`type\` 取 \`column\`（柱状）/ \`bar\`（条形）/ \`line\`（折线）/ \`pie\`（饼图，只吃一组 series 且值非负）；\`categories\` 2–12 个；\`series\` 1–4 组，每组 \`{ name, values }\` 与 categories 等长。图表以矢量形状绘制——PowerPoint 里可以改色改字，**改数据要重新导出**（如实告知用户）。

一套 deck 的标准骨架：cover → （section…）→ 内容页若干 → 结尾不要空「谢谢」页。用户给了品牌色就写进 \`theme.accent\`（RRGGBB 不带 #），引擎会派生整套配色。

## 二、每页信息量（两种路线都适用）

- 标题 ≤ 20 字；要点 **3–8 条**；每条 ≤ 20 字。
- 超了就**拆页**，不要指望压缩字号——16:9 的页面塞不下就是塞不下。
- 一页只讲一件事。要紧的结论放标题里，不要放第 5 条要点。
- 表格 ≤12 行，多了拆成两页；数据来源写在该页 \`note\`（页底来源行）里。

## 三、表达不了的（如实告知）

- **deck 路线**：图表改数据需重新导出（形状不是活图表）；无母版/动画/切换；不指定中文字体（打开端自行替换）；slides 上限 200 页。
- **markdown 路线**：图片降级成文字（末尾追加「备注」页列损失）；无图表、无版式变化，固定 16:9。
- **两路线都没有**：母版定制、动画、切换。用户给的公司模板价值在母版——那走 \`office_edit\`（见下）。

## 四、套模板（office_edit 的主场）

用户给的公司模板，价值全在母版。做法：

1. \`outline\` 拿每页的 shape_id、名称、占位符类型与原文——**先看再动**。
2. \`set_shape_text\` 逐形状重写内容。表格单元格的 id 形如 \`cell:r:c\`。
3. **段落样式继承自母版，不要覆盖。** 别顺手 \`format_text\` 改字体字号——那正是模板存在的意义。
4. **PPT 不会自动重排。** 新文本明显长于原文就会溢出文本框：拿 \`outline\` 给出的原文当标尺（PPT 没有 docx 那样的预算字段，长度得自己看），超了先换行 / 拆页 / 改措辞，再落笔。
5. 幻灯片编号、页码、日期是域（\`a:fld\`），永远不参与匹配，交给 PowerPoint 自己算。

要指定中文字体时（生成端给不了）：\`format_text\` 传 \`font\`（如 \`微软雅黑\`），引擎会同时写西文与东亚字体，中文同样生效。

## 五、配色与字号

- deck 的配色由 \`theme.accent\` 一处驱动（引擎派生浅底、卡片、图表主色）；默认 2F54EB。
- \`office_edit\` 手工样式时：颜色写 6 位 \`RRGGBB\` 不带 \`#\`；字号阶梯（pt）封面主标题 40–44 / 页标题 28–32 / 要点 18–22 / 注释与来源 12–14；一套 deck 最多 2–3 个强调色，正文近黑（\`262626\`），强调色只给标题或关键数字。
- 底色 / 形状色用 \`set_shape_fill\`（\`"none"\` 表示无填充）、\`set_slide_background\`；位置尺寸用 \`set_shape_geometry\`（单位**英寸**）。
- 样式类算子不允许改变可见文字——引擎会在文字被改动时拒绝整批。这是防"改样式顺手把内容改没了"的护栏，不是限制。

## 六、交付前

- 封面有信息（标题 / 副标题）；每页都有标题，没有一页只剩一行；结尾不要留空「谢谢」页。
- deck 路线的图片必须先存在于工作区（没有就先画 SVG/PNG 存进去或如实说明）；图片页记得写 caption。
- markdown 路线追加的「备注」页（列降级损失）在回复里提一句，别让它莫名出现在成品末尾。
- 数字页（kpi / chart / table）的口径与来源写在 \`note\` 里，或在回复里说明。
`,
}
