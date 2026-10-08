/**
 * The office skill's per-format rule sets — the files SKILL.md names but does
 * not inline, seeded to `~/.pulsemind/skills/office/references/` by
 * ensureBuiltInSkills so the `read` tool can reach them (pick_skill only ever
 * returns the SKILL.md body).
 *
 * Every claim here is checked against the implementation, because a rule set
 * that promises more than the engine does is worse than no rule set:
 *   - markdown → docx mapping: office-export/md-to-docx.ts (fonts are never
 *     chosen — the document-level controls are the export_document `fontSize`
 *     and the markdown frontmatter (cover/header/footer/toc/indent/accent),
 *     parsed by parseDocxFrontmatter; unknown keys land in a closing note)
 *   - markdown → xlsx: office-export/md-tables.ts + cell-type.ts (a bare grid —
 *     no styles, no formulas)
 *   - markdown → pptx: office-export/md-to-pptx.ts (slide limit 200, bullet
 *     level capped at 2, one table per page, fixed 16:9)
 *   - html design route → pptx: office-export/html-measure.ts + html-to-pptx.ts
 *     (Chromium-measured layout facts → positioned shapes; profile rules below
 *     are checked by the engine, not aspirational; charts draw via
 *     chart-draw.ts from data-chart annotations)
 *   - edit operators and refusals: shared/office/ops.ts + each tool's manual
 *   - pptx `format_text` font writes BOTH a:latin and a:ea (pptx/ops.ts), so a
 *     CJK face name takes effect on Chinese text — that is why the recipe below
 *     can promise it.
 */

export const OFFICE_SKILL_REFERENCES: Record<string, string> = {
  'references/docx.md': `# Word 交付规范（docx）

生成走 \`export_document\`（format docx，输入 markdown）；改已有文件走 \`office_edit\`。

## 一、版式 = markdown 正文 + frontmatter 文档设计

生成端是 markdown → docx 的映射。正文版式用 markdown 表达：

| markdown | 落到 docx 上 |
|---|---|
| \`#\` – \`######\` | Heading1 – Heading6 |
| 空行分段 | 独立段落 |
| \`**粗**\` \`*斜*\` \`~~删~~\`、以及用反引号包住的代码 | 加粗 / 斜体 / 删除线 / 等宽（可组合：\`***粗斜***\` 同时落两标志） |
| \`[文字](url)\` | 超链接 |
| \`![alt](workspace/图片.png)\` | 正文行内图片（工作区路径，png/jpg/jpeg/gif；宽上限 600px 等比缩） |
| 无序 / 有序列表 | 项目符号 / 编号，嵌套 ≤3 层（更深会被拍平） |
| 表格 | 表格（表头行加粗带底纹） |
| 代码块 | 等宽 + 浅灰底纹段落；声明语言（\`\`\`js）且属常用语言时带语法高亮着色，未声明/未注册语言纯文本 |
| \`>\` 引用 | 缩进 + 左边框段落 |
| \`[^1]\` 引用 + 行首 \`[^1]: 文字\` 定义 | 真脚注（单行定义；引用了不存在的定义会原文照旧并在文末点名） |
| \`\`\`chart 围栏（data-chart 同方言 JSON） | 图表落成居中图片（引擎用浏览器内核把图表渲染成 PNG）；配色随 frontmatter accent；浏览器内核缺席时降级为代码块 + 文末注 |
| \`---\` | 水平分隔线 |

**文档级设计（封面/页眉页脚/页码/目录/缩进/主题）写在 markdown 头部的 frontmatter 里**，全部可选，不给就是素文档：

\`\`\`
---
title: 年度报告          # 有 title 才生成封面页（正文同文的首个 H1 不再重复）
subtitle: 副标题         # 可选
author: 撰写人           # 可选
date: 2026-10-07         # 可选（你自己填，引擎不注入时钟）
toc: true                # 目录（正文最前，之后自动分页）
toc-depth: 3             # 可选，1–3，默认 3
header: 文档页眉文字      # 可选，正文页眉
footer: page             # 可选：page（第 X 页）| total（第 X 页 共 Y 页）| off
indent: true             # 正文段落首行缩进 2 字符（公文场景）
accent: "#0F766E"        # 可选主题色：引用块/表头底纹/标题底线随之着色
---
\`\`\`

frontmatter 的键必须照上表拼写——未识别的键、解析不了的值会在文末注里点名（不会静默忽略）。目录在预览/PDF 里显示的是静态条目（无页码），页码以 Word/WPS 打开后更新域为准——用户在 Word 里打开时按提示更新即可，如实转述这一点。

整份文档的字号用 \`export_document\` 的 \`fontSize\`（磅，6–72 可带 0.5：10.5=五号、12=小四、14=四号、16=三号）：它设的是**正文基准**，标题与代码块按同一比例缩放，层级不塌（不给就是 Word 默认 11 磅）。要让某一两处不一样：先导出，再用 \`office_edit\` 的 \`format_text\` 带 \`font_size\` 单点改。

## 二、表达不了的（别硬凑，如实说）

- **插入图片（网络/内联地址）**：\`http(s)://\` 与 \`data:\` 的图片不嵌图，保持占位文字（形如 \`[图片:xxx.png,正文不支持]\`）——工作区里的图片文件才会真正嵌入。
- **公式、内嵌 HTML**：原文照抄 + 文末一行说明。
- **字体与局部字号**：字体从不指定，Word / WPS 按自己的默认样式渲染（CJK 由打开端替换；只有代码块固定等宽 Courier New）。字号只有 \`fontSize\` 这一个全文基准，**没有逐段字号**——逐段的先导出，再用 \`office_edit\` 的 \`format_text\` 改。
- **页眉页脚/目录/域的后期编辑**：\`office_edit\` 改不了这些（只管正文段落与表格）——生成端一次给足，返工就改 frontmatter 重新导出。
- **行距、分节、页面设置**：无（行距是既定的 1.5 倍排版，不收参数）。
- **chart 围栏的两个边界**：图表是**图片**不是活图表（改数据 = 改 JSON 重新导出，同 PPT 的 data-chart 契约）；方言校验失败会整单拒绝并点名第几个围栏——JSON 写认真些。
- **多行脚注**：脚注定义只认单行，续行会落回正文——长注释请写进正文或表格。

## 三、四种高频场景的结构

**报告 / 调研**
\`\`\`
---
title: 标题（一句话说清结论方向）
date: 2026-10-07
toc: true
footer: page
---
# 标题（封面已承载，正文不再重复写同文 H1）
（摘要段：结论先行，2–4 句）
## 一、背景
## 二、发现      ← 数据一律进表格，不要用长句罗列数字
## 三、结论与建议
\`\`\`

**公文**
- frontmatter 给 \`indent: true\`（首行缩进 2 字符）+ \`footer: page\`；标题放 frontmatter \`title\` 会带封面页——公文通常**不要封面**，标题就用 \`#\` 写在正文。
- 落款（单位、日期）各占一个独立段落。
- 不用引用块、分隔线、emoji 这类装饰元素——正式文种里它们不合适。

**合同 / 协议**
- frontmatter 给 \`header: 文档名\`（每页页眉）与 \`footer: total\`（页码含总页数，便于"见第 X 页"引用）；封面按需。
- 条款用有序列表 \`1.\` \`2.\`，层级不超过 3 层。
- 关键条款、待填空处用 \`**加粗**\` 标出，让用户一眼看到。
- 金额写清币种与单位（"人民币 12,000 元"），不要只写数字。
- 需要用户填的空用 \`____\` 或 \`【】\`，并在回复里列出"需要你确认的空有哪几处"。

**简历**
- \`#\` 姓名 → 下一行放联系方式（一条段落，用 \` | \` 分隔）→ \`##\` 分板块（工作经历 / 项目 / 教育 / 技能）。
- 每段经历用 \`###\` 或加粗行写"公司 · 职位 · 时间"，下面用无序列表列成果；成果尽量带数字。
- 日期写成文本（如 \`2024.03 — 2026.09\`）。不能右对齐，也别指望。
- 简历**不要** frontmatter \`title\`（那会生成封面页）；一页纸内说完。

## 四、编辑要点（office_edit·docx）

- **先 \`office_inspect\`**：拿段落索引 + 样式 + 文本长度与文本预算，索引是后续 op 的定位依据；\`replace_text\` 的 find 要精确原文时用 \`office_read\` 分页读（它的文本才是匹配空间，\`read\` 的 markdown 是重排过的，抄进来会错位）。
- **索引随批次变化**：同一批里前面的 \`insert_paragraph\` / \`delete_paragraph\` 会改变后面段落的编号。按你对最终形态的意图排列顺序。
- **\`replace_text\` 默认要求恰好命中 1 处**，命中数不符整批拒绝。多处的用 \`expected_count\` 或 \`paragraph\` 收窄——不要靠"反正会改第一处"。
- **表格能改文字，也能加行删行**：\`insert_table_row\`（\`after_row\` 后插，可带每格文字，克隆锚点行的边框列宽）/ \`delete_table_row\`。护栏会拒绝竖向合并（vMerge）、嵌套表和删最后一行——撞上就如实说明并给替代。**加列 / 删列做不到**：Word 表没有任何单格写算子，\`insert_table_row\` 也不接受超出既有列数的 cells——加列唯一出路是重出一张表（改 markdown 重新 \`export_document\`）。
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

- **样式只有两样**：表头加粗 + 列宽自适应（按最长内容，封顶 50）。底纹、边框、冻结窗格、条件格式仍然没有——除这两样外，产物就是干净的值网格。
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

生成一律走**设计路线**（§七）：风格对齐 → tokens.css → deck.html → \`export_document\`（format pptx + \`htmlPath\`）；markdown \`content\` 只是纯文字大纲的兜底（§三）。改已有文件或套模板走 \`office_edit\`（§四）。

## 一、从零生成只走设计路线

从零做 PPT **只有一条生成路线**：设计路线（§七）——风格对齐 → \`write\` tokens.css → \`write\` deck.html → \`export_document\`（format pptx + \`htmlPath\`）。你给的是「这一页长什么样」的 CSS，引擎用 Chromium 实测布局后输出**原生可编辑形状**（不是截图）。

流程总览与 profile 全文见 §七；本文件 §二（每页信息量）、§五（配色与字号）两条路线通用。

## 二、每页信息量（设计路线与 markdown 兜底都适用）

- 标题 ≤ 20 字；要点 **3–8 条**；每条 ≤ 20 字。
- 超了就**拆页**，不要指望压缩字号——16:9 的页面塞不下就是塞不下。
- 一页只讲一件事。要紧的结论放标题里，不要放第 5 条要点。
- 表格 ≤12 行，多了拆成两页；数据来源写在该页 \`note\`（页底来源行）里。

## 三、表达不了的（如实告知）

- **设计路线**：色块/边框/表格底色/页背景的**半透明会映射**成 PowerPoint 透明度（rgba 可用）；**文字色**仍不收半透明（改调淡 hex 或 --pm-muted）；链接（\`<a>\`）只保留文字（href 进不了 pptx）；\`visibility:hidden\` 的内容不转换（预览看不见的，pptx 也不出）；渐变/CSS 变换/动画进不了 pptx；图表改数据 = 改 \`data-chart\` 标注后重转（形状不是活图表）；无母版/动画——用户公司模板的价值在母版，那走 \`office_edit\`（§四）。
- **markdown 兜底路线**：图片降级成文字（末尾追加「备注」页列损失）；无图表、无版式变化，固定 16:9。
- **两条路线都没有**：母版定制、动画、切换。

## 四、套模板（office_edit 的主场）

用户给的公司模板，价值全在母版。做法：

1. \`office_read\`（slide 省略读全篇，或 slide=N 按页）拿每页的 shape_id、名称、占位符类型与原文——**先看再动**。
2. \`set_shape_text\` 逐形状重写内容。表格单元格的 id 形如 \`cell:r:c\`。
3. **段落样式继承自母版，不要覆盖。** 别顺手 \`format_text\` 改字体字号——那正是模板存在的意义。
4. **PPT 不会自动重排。** 新文本明显长于原文就会溢出文本框：拿 \`office_read\` 给出的原文当标尺（PPT 没有 docx 那样的预算字段，长度得自己看），超了先换行 / 拆页 / 改措辞，再落笔。
5. 幻灯片编号、页码、日期是域（\`a:fld\`），永远不参与匹配，交给 PowerPoint 自己算。

要指定中文字体时（生成端给不了）：\`format_text\` 传 \`font\`（如 \`微软雅黑\`），引擎会同时写西文与东亚字体，中文同样生效。

## 五、配色与字号

- 设计路线的配色由 tokens.css 一处驱动（§七 §1）；图表主色取 \`--pm-accent\`，先骑系列色首位；**伴生系列色引擎自动从 accent 色相派生**（金黄角轮转拉开色距，单色主题按明度阶梯区分）——图表永远和整套 deck 一家，不用你在 html 里挑第二三种颜色。
- \`office_edit\` 手工样式时：颜色写 6 位 \`RRGGBB\` 不带 \`#\`；字号阶梯（pt）封面主标题 40–44 / 页标题 28–32 / 要点 18–22 / 注释与来源 12–14；一套 deck 最多 2–3 个强调色，正文近黑（\`262626\`），强调色只给标题或关键数字。
- 底色 / 形状色用 \`set_shape_fill\`（\`"none"\` 表示无填充）、\`set_slide_background\`；位置尺寸用 \`set_shape_geometry\`（单位**英寸**）。
- 样式类算子不允许改变可见文字——引擎会在文字被改动时拒绝整批。这是防"改样式顺手把内容改没了"的护栏，不是限制。

## 六、交付前

- 封面有信息（标题 / 副标题）；每页都有标题，没有一页只剩一行；结尾不要留空「谢谢」页。
- 设计路线的图片必须先存在于工作区（html 里相对路径引用，png/jpg/gif）；转换成功结果带保真报告，交付时如实转述降级项。
- markdown 兜底路线追加的「备注」页（列降级损失）在回复里提一句，别让它莫名出现在成品末尾。
- 数字页（图表/表格/大数字）的口径与来源写在页脚或回复里说明。

## 七、设计路线（htmlPath：HTML → pptx）

这是从零做 PPT 的**唯一生成路线**。四步：**风格对齐**（与用户确认，不要跳过）→ \`write\` tokens.css（主题落定）→ \`write\` deck.html（版式与内容）→ \`export_document\`（format pptx + \`htmlPath\`）。引擎用 Chromium 实测布局后输出**原生可编辑形状**（不是截图），产物预览与 HTML 一致。写 deck.html 按内容与确认的气质自由设计——§3 的示例是写法参照，不是模板；**先出样张**（封面 + 一页正文）导出确认气质，再补全篇。

### 0. 风格对齐：先定调，再动手

写任何文件之前，先和用户完成一次风格确认——**设计路线没有「默认主题兜底」这回事**：引擎内置的默认变量只是防止预览坏掉的技术兜底，不是你的设计起点，跳过对齐直接动手是这条路线的第一错误。做法：

1. 依据用户给的品牌色 / 参考图 / 场景（汇报？路演？课程？），整理 **1–3 个风格方向**，每个方向给：主色 + 面板/辅助色（具体 hex）、明暗倾向、中文字体、一句话气质（如「深蓝 + 灰白的稳重商务」「暖米 + 砖红的杂志感」）。
2. 用户说不清想要什么时，用**方向对比**帮他说清（「A 更稳重、B 更年轻，偏哪个？」）；用户已给明确品牌色板时直接复述确认即可，不必硬造三个方向。
3. **用户确认即落定**：把确认结果写进 tokens.css。落定之后这套变量就是本 deck 的唯一主题——改风格 = 改 tokens.css 重转，HTML 与内容零改动；不要在 HTML 里另起炉灶硬写颜色。

### 1. tokens.css：把确认的风格落成 14 个变量

固定 schema 的 14 个变量（7 色 + 3 字体 + 4 字号阶），别写别的：

\`\`\`css
:root {
  /* 色 */
  --pm-accent: #C2483B;       /* 强调色：短条、编号、关键数字、图表主色——只给焦点，禁大面积铺色 */
  --pm-accent-soft: #F5DDD9;  /* 强调色的浅色层：徽标底、浅色强调块（替代半透明的唯一做法） */
  --pm-ink: #1F1F1F;          /* 正文墨色 */
  --pm-muted: #8A8A8A;        /* 次要文字 */
  --pm-panel: #F6F1EA;        /* 卡片/面板底 */
  --pm-bg: #FFFFFF;           /* 页面底色 */
  --pm-line: #E0DAD2;         /* 发丝线/分割线（配 1px 高的色块，不用 border 也行） */
  /* 字体 */
  --pm-font-zh: '微软雅黑';     /* 中文字体 */
  --pm-font-latin: 'Arial';   /* 西文字体 */
  --pm-font-mono: 'Menlo';    /* 等宽：数字、页码（3 / 14）、技术标注——数字用它，气质立刻不同 */
  /* 字号阶（html 里引用 var(--pm-fs-*)；改阶 = 改这里，HTML 零改动） */
  --pm-fs-cover: 48px;        /* 封面巨标 */
  --pm-fs-title: 30px;        /* 页标题 */
  --pm-fs-body: 18px;         /* 正文 */
  --pm-fs-note: 13px;         /* 注释/页脚 */
}
\`\`\`

- 颜色一律 \`#RRGGBB\`（或 #RGB）**不透明**；字号阶是 8–200 的整像素数。
- 字体白名单：微软雅黑 / Microsoft YaHei / PingFang SC / 苹方-简 / 黑体 / 宋体 / 等线 / 楷体 / 仿宋 / Arial / Helvetica / Calibri / Segoe UI / Georgia / Times New Roman / Verdana / Tahoma / Trebuchet MS / Courier New / Consolas / Menlo / Monaco / SF Mono / JetBrains Mono / Source Code Pro / Roboto Mono。一次一个名字。
- **字号阶必须被引用**：html 里的 font-size 写 \`var(--pm-fs-title)\` 这类引用（页标题/正文/页脚一律如此，个别特殊字号才直接写 px）——这是「换主题字号跟着变」的机制。
- **设计路线总是先有 tokens.css 再有 deck.html**——上一节风格对齐确认了才写，不要靠引擎默认变量出片；改主题 = 改这一个文件重转，HTML 零改动。
- tokens.css 与 deck.html 同目录，html 里 \`<link rel="stylesheet" href="./tokens.css">\`（唯一允许的 link）。

### 2. deck.html：受限 profile（白名单之外整单拒绝、点名页码与元素）

每页一个 \`<div class="slide">\`（必须 \`width:960px; height:540px\`，按文档顺序成页，≤200 页）：

\`\`\`html
<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./tokens.css">
<style>
  body { margin: 0 }
  .slide { width: 960px; height: 540px; position: relative; background: var(--pm-bg) }
</style></head><body>
  <div class="slide">
    <div style="position:absolute; left:64px; top:200px; width:600px">
      <h1 style="font-size:var(--pm-fs-cover); color:var(--pm-ink)">季度经营回顾</h1>
    </div>
    <div style="position:absolute; left:64px; top:320px; width:600px">
      <p style="font-size:var(--pm-fs-body); color:var(--pm-muted)">2026 Q3 · 增长与效率</p>
    </div>
    <div style="position:absolute; left:760px; top:0; width:200px; height:540px; background:var(--pm-accent)"></div>
  </div>
</body></html>
\`\`\`

**能用**：h1–h6、p、ul/ol/li（真项目符号，嵌套 ≤2 层）、table（th/td，逐格底色字号生效）、img（工作区 png/jpg/gif，相对路径；**object-fit:cover** 满版裁切——封面大图的关键）、div/span（色块卡片：background/border/border-radius/**虚线点线**都映射；**rgba 半透明**映射 PowerPoint 透明度，图片蒙版、玻璃卡片、浅色叠层全靠它；**单层外阴影** \`box-shadow: 0 2px 8px rgba(0,0,0,0.10)\` 映射 PowerPoint 阴影——卡片 elevation 就这一招）、b/strong/i/em/u/s、布局用 absolute 或流式 + flex；字号（引用 var(--pm-fs-*)）字色、行高、对齐、**字距（letter-spacing——眉题 kicker、大数字 tracking 的气质开关）**、等宽（font-family 只许 var(--pm-font-mono) 等三个字体变量）按浏览器实测落。960×540 @96dpi ≡ 10×5.625 英寸，浏览器里的 1px 在 pptx 里是 0.75pt。

**禁用（会整单拒绝）**：\`<script>\`、@font-face、svg/iframe/video/canvas 等白名单外元素；渐变（背景只收纯色）；**半透明文字色**（rgba 的文字色拒绝——文字没有透明度可映射，改用调淡后的 hex）；transform / position:fixed / CSS 动画；在 HTML 里写字体名（font-family 只允许 var(--pm-font-…) 引用）；网络或内联资源（src 只能工作区文件）；表格 colspan/rowspan。**内容超出 960×540 也拒绝**——装不下就缩小或拆页。**文字与文字/表格/图表的区域相交也会拒绝**并点名两者——绝对定位按实际渲染高度排，拿不准就把下方元素多留一行高；文字压在**先画**的色块卡片或蒙版图上是合法的（那是设计手法），但**色块/图片排在文字之后且与文字相交也会拒绝**——那会把字盖掉，内容区从上往下排，别让下方的卡片顶进上方文字的行盒。**文字被 overflow:hidden/clip 裁剪同样拒绝**——预览里被裁掉的部分在 pptx 里会完整显示；去掉裁剪让超界被真实检测，或缩短文字、加高盒子。多层 / inset / spread 的 box-shadow、元素 opacity、非居中的 object-position、double/groove 等异形边框（按实线处理）映射不了，会在保真报告里如实列出，不静默丢弃。转换器已把文本框内边距清零并按对齐方向加了少量安全余量（右对齐向左扩、左对齐向右扩，锚点不动）——html 里量出的位置就是 pptx 里的位置，页码这类窄文本框不会因此折行。

**图表用标注，不要画 SVG**——引擎按 deck 同款词汇画原生形状（PowerPoint 里可改色改字，改数据 = 改标注后重转）：

\`\`\`html
<div data-chart='{"type":"column","categories":["Q1","Q2","Q3"],"series":[{"name":"营收","values":[120,135,158]}]}'
     style="position:absolute; left:64px; top:120px; width:600px; height:360px"></div>
\`\`\`

图表 JSON 与 deck 的 chart 字段同一 schema：type 取 column/bar/line/pie；categories 2–12 个；series 1–4 组与 categories 等长；pie 只吃一组且非负。

### 3. 版式：自由创作，示例只教写法

deck.html 的版式**自己设计**——从内容和 §0 确认的气质出发，按 §2 的 profile 自由写：时间轴、步骤条、左图右文、大图卡、网格清单、中轴对称、留白极简……profile 之内的写法都合法，引擎按浏览器实测落成形状。下面的示例只回答一件事：「这类写法能不能转换、怎么写才落得准」——它们是**参照，不是模板**。默认按自己的内容构图，结构和版式要从当次的内容与气质里长出来；示例在拿不准某类写法时对照，或用户要得急时当起稿骨架——拿来了就改结构换构图，别只换文字。

**全篇一致靠自定的基线，不靠照搬示例。**每份 deck 自己定四个基线并全篇统一：页边距（示例 64px）、标题块位置（示例 left:64 top:56 + 28×4 的 accent 短条）、页码（示例 left:832 top:496 width:64 右对齐，mono + --pm-fs-note，封面/结束页不放）、圆角一个值（示例 8px）。数值按气质定，**一经选定全篇不动**，变体页也遵守——一致性来自全篇统一，不是和示例一致。

**构图基准**（下面的示例组件按它设计，不是硬边界）：主内容一般落在 top:170–480 的带里（480 以下留给页码），左右留足呼吸（示例 ≥64px）；并排两块给宽度比例（如 38% / 59%，gap:24px）。大图卡、通栏色块这类吃满页面的版式尽管出带——硬边界只有一条：**文字与文字/表格/图表的区域不相交**（相交会被整单拒绝并点名两者）。

**满版页**（反色、大图、大字这类页面）豁免「accent 单页 ≤10%」纪律（那条管正文页），全篇至少 2–3 页满版造节奏。反白文字在深底上一律 var(--pm-bg)，不要写死 #FFFFFF。

**样张先行**：先把「封面 + 一页正文」两张样张 \`export_document\` 导出、在预览面板确认气质，对了再补全篇重导——改 HTML 便宜，写完 14 页才发现方向不对才是贵的。

#### 满版页示例：封面 / 章节扉页 / 金句 / 结束

看的是结构写法——object-fit:cover 铺满 + rgba 蒙版 + 反白巨标、mono 大编号、反色大字、accent 满版反白。构图、编号、断行、气质自定：**每份 deck 的封面不该长得一样**。

**A · 封面**（满版图 + 蒙版 + 反白巨标）

\`\`\`html
<div class="slide" style="background:var(--pm-ink)">
  <img src="assets/cover.jpg" style="position:absolute; left:0; top:0; width:960px; height:540px; object-fit:cover">
  <div style="position:absolute; left:0; top:0; width:960px; height:540px; background:rgba(0,0,0,0.45)"></div>
  <div style="position:absolute; left:64px; top:368px; width:832px">
    <p style="font-size:var(--pm-fs-note); color:var(--pm-bg); letter-spacing:4px; margin:0 0 12px">2026 · 第三季度</p>
    <h1 style="font-size:var(--pm-fs-cover); color:var(--pm-bg); margin:0; line-height:1.15">季度经营回顾</h1>
  </div>
</div>
\`\`\`

（图片换成工作区里的真实图；用户没给图就直接用 B 的纯色满版，别硬凑。）

**B · 章节扉页**（反色满版 + 大编号）

\`\`\`html
<div class="slide" style="background:var(--pm-ink)">
  <p style="position:absolute; left:64px; top:150px; font-family:var(--pm-font-mono); font-size:96px; color:var(--pm-accent); margin:0; line-height:1">02</p>
  <h1 style="position:absolute; left:64px; top:280px; width:700px; font-size:var(--pm-fs-cover); color:var(--pm-bg); margin:0">增长与效率</h1>
  <p style="position:absolute; left:64px; top:400px; width:600px; font-size:var(--pm-fs-body); color:var(--pm-muted); margin:0">本章讲清三件事：收入结构、成本曲线、下季度的杠杆</p>
  <div style="position:absolute; left:832px; top:496px; width:64px; text-align:right; font-family:var(--pm-font-mono); font-size:var(--pm-fs-note); color:var(--pm-muted)">2 / 14</div>
</div>
\`\`\`

**G · 金句页**（反色大字）

\`\`\`html
<div class="slide" style="background:var(--pm-ink)">
  <p style="position:absolute; left:64px; top:120px; width:832px; font-size:36px; color:var(--pm-bg); line-height:1.6; margin:0">「把成本曲线打下来，<br>增长才有力可言。」</p>
  <p style="position:absolute; left:64px; top:400px; font-size:var(--pm-fs-note); color:var(--pm-muted); margin:0">— 2026 Q3 经营会纪要</p>
  <div style="position:absolute; left:832px; top:496px; width:64px; text-align:right; font-family:var(--pm-font-mono); font-size:var(--pm-fs-note); color:var(--pm-muted)">9 / 14</div>
</div>
\`\`\`

（金句两行以内，\`<br>\` 自己控制断行；引用出处必须有。）

**H · 结束页**（accent 满版反白）

\`\`\`html
<div class="slide" style="background:var(--pm-accent)">
  <h1 style="position:absolute; left:64px; top:220px; width:700px; font-size:var(--pm-fs-cover); color:var(--pm-bg); margin:0">谢谢，等问题。</h1>
  <p style="position:absolute; left:64px; top:340px; font-size:var(--pm-fs-body); color:var(--pm-bg); margin:0">数据与图表出处都在会话工作区的 deck.html</p>
</div>
\`\`\`

#### 正文页示例（C）：标题块 + 内容带的最小拼法

演示正文页的最小可转换结构——标题块（top:56）+ 内容带里的一段内容 + 页码。照此自由组装，也可以不用这个骨架、按内容另起构图：

\`\`\`html
<div class="slide" style="background:var(--pm-bg)">
  <div style="position:absolute; left:64px; top:56px; width:832px">
    <div style="width:28px; height:4px; background:var(--pm-accent); margin-bottom:14px"></div>
    <h2 style="font-size:var(--pm-fs-title); color:var(--pm-ink); margin:0">收入结构：三条曲线</h2>
  </div>
  <ul style="position:absolute; left:64px; top:170px; width:700px; line-height:1.7">
    <li style="font-size:var(--pm-fs-body); color:var(--pm-ink)">订阅收入占比首次过半（58%）</li>
    <li style="font-size:var(--pm-fs-body); color:var(--pm-ink)">大客户续约率 92%，创三年新高</li>
  </ul>
  <div style="position:absolute; left:832px; top:496px; width:64px; text-align:right; font-family:var(--pm-font-mono); font-size:var(--pm-fs-note); color:var(--pm-muted)">3 / 14</div>
</div>
\`\`\`

（结论进标题，要点 ≤20 字；每个要点独立一行。）

#### 内容组件示例（按内容带 left:64 / top:170 / width:832 的基准设计）

同一信息有多种表达：要点可以是列表也可以是编号大字，对比可以左右也可以上下，数据可以进图表也可以做大数字。示例给的是一种写法，不是唯一写法——按内容选表达，按气质改细节。

**① 要点列表**——一行一个结论：

\`\`\`html
<ul style="position:absolute; left:64px; top:170px; width:760px; line-height:1.7">
  <li style="font-size:var(--pm-fs-body); color:var(--pm-ink)">订阅收入占比首次过半（58%）</li>
  <li style="font-size:var(--pm-fs-body); color:var(--pm-ink)">大客户续约率 92%，创三年新高</li>
  <li style="font-size:var(--pm-fs-body); color:var(--pm-ink)">硬件毛利承压，Q4 重点改善</li>
</ul>
\`\`\`

**② 卡片行**——2–4 张（\`flex:1\` 自动均分，gap:24），卡顶强调条 + mono 编号：

\`\`\`html
<div style="position:absolute; left:64px; top:170px; width:832px; display:flex; gap:24px">
  <div style="flex:1; background:var(--pm-panel); border-radius:8px; border-top:3px solid var(--pm-accent); padding:24px">
    <p style="font-family:var(--pm-font-mono); font-size:var(--pm-fs-note); color:var(--pm-accent); margin:0 0 8px">01</p>
    <h3 style="font-size:var(--pm-fs-body); color:var(--pm-ink); margin:0 0 8px">订阅提价</h3>
    <p style="font-size:var(--pm-fs-body); color:var(--pm-muted); margin:0; line-height:1.5">续约率有冗余，可承受一轮 5–8% 的试探性提价。</p>
  </div>
  <div style="flex:1; background:var(--pm-panel); border-radius:8px; border-top:3px solid var(--pm-accent); padding:24px">
    <p style="font-family:var(--pm-font-mono); font-size:var(--pm-fs-note); color:var(--pm-accent); margin:0 0 8px">02</p>
    <h3 style="font-size:var(--pm-fs-body); color:var(--pm-ink); margin:0 0 8px">渠道下沉</h3>
    <p style="font-size:var(--pm-fs-body); color:var(--pm-muted); margin:0; line-height:1.5">二线城市装机量翻倍，先铺服务再谈转化。</p>
  </div>
</div>
\`\`\`

**③ 大数字 + 说明**——数字写结论本身，口径进 caption；来源写在页脚或回复里：

\`\`\`html
<div style="position:absolute; left:64px; top:190px; width:240px">
  <p style="font-family:var(--pm-font-mono); font-size:72px; color:var(--pm-accent); margin:0; line-height:1">58%</p>
  <p style="font-size:var(--pm-fs-body); color:var(--pm-muted); margin:10px 0 0">订阅收入占比，首次过半</p>
</div>
\`\`\`

**④ 图表**——标注即图表（schema 见上文 data-chart）：

\`\`\`html
<div data-chart='{"type":"line","categories":["Q4","Q1","Q2","Q3"],"series":[{"name":"订阅占比 %","values":[38,44,51,58]}]}' style="position:absolute; left:360px; top:170px; width:536px; height:310px"></div>
\`\`\`

**⑤ 对比栏**——两块并排 = 对比页（第二块 left:492 width:404 同款；左现状右建议）：

\`\`\`html
<div style="position:absolute; left:64px; top:170px; width:404px; height:310px; background:var(--pm-panel); border-radius:8px; padding:24px">
  <h3 style="font-size:var(--pm-fs-body); color:var(--pm-ink); margin:0 0 10px">A · 稳守</h3>
  <ul style="margin:0; padding-left:20px; line-height:1.7">
    <li style="font-size:var(--pm-fs-body); color:var(--pm-muted)">保续约，不加投入</li>
    <li style="font-size:var(--pm-fs-body); color:var(--pm-muted)">毛利率 +1pt</li>
    <li style="font-size:var(--pm-fs-body); color:var(--pm-muted)">风险：增长失速</li>
  </ul>
</div>
\`\`\`

**⑥ 表格**——表头 accent 反白、行高 40px、≤12 行（§二），口径与来源写进回复：

\`\`\`html
<table style="position:absolute; left:64px; top:170px; width:832px; border-collapse:collapse">
  <tr><th style="background:var(--pm-accent); color:var(--pm-bg); font-size:var(--pm-fs-body); padding:8px 12px; text-align:left">机型</th><th style="background:var(--pm-accent); color:var(--pm-bg); font-size:var(--pm-fs-body); padding:8px 12px; text-align:left">起售价</th></tr>
  <tr><td style="font-size:var(--pm-fs-body); color:var(--pm-ink); padding:8px 12px">iPhone 18 Pro</td><td style="font-size:var(--pm-fs-body); color:var(--pm-ink); padding:8px 12px">¥7,999</td></tr>
</table>
\`\`\`

组件可以两两并排（③+④ 就是数据页；并排时给宽度比例、共享 top:170 基线），但不要叠三层——超出内容带的组合先想想是不是该拆两页。

### 4. 转换与交付

- \`export_document\`（format pptx、htmlPath 指向 deck.html、file_path 给成品名）。**先 write 完 tokens 与 html 再调用**；profile 校验拒绝残缺 HTML 时按报错修完重试。
- 成功结果带**保真报告**（每页块数 + 降级清单）——交付时如实转述给用户。
- **双源契约**：HTML 是创作源——改版式/换主题 = 改 tokens.css 或 deck.html 重新导出；**交付后的小改走 office_edit**，不要改了 HTML 就重转（会丢掉已在 pptx 上做过的 office_edit 修改）。

### 5. 设计 checklist（交付前）

- 每页一个视觉重心：大标题 / 大数字 / 一张图；不要三栏小字挤一页。
- 取色一律 var(--pm-*)，别硬写 hex——用户换品牌色才不用重写 HTML。
- **强调色纪律**：accent 只给焦点元素（标题短条、章节编号、关键数字、图表主色），单页面积 ≤10%，禁止大面积铺色；浅色强调用 --pm-accent-soft。
- **节奏**：全篇至少 2–3 页显著不同（满版反白/大图 vs 常规白底），别 14 页一个模子；章节扉页、封面、结束页可以放开做满版。
- **满版图页的结构**（封面/章节页的高级感主要来自这个构图）：\`<img>\` 设 \`object-fit:cover\` 铺满 960×540 → 上面叠一层 \`background:rgba(0,0,0,0.35)\` 的全页色块做蒙版（半透明映射透明度）→ 反白标题压在蒙版上层。文字块之间仍不相交即可，蒙版色块与文字相交是合法的（只有文字压文字才拒绝）。
- **密度与呼吸**：视觉锚点周围 ≥40px 空白；卡片内容占满容器（别只有半截字吊着）；横向并排的卡片标题基线对齐。
- 字号走 var(--pm-fs-*) 阶梯（改阶不改 HTML）；页脚/页码惯例：右下 \`var(--pm-font-mono)\` + \`--pm-fs-note\`，写 \`3 / 14\` 样式；封面与结束页不放页码。
- 逐元素 absolute 时留页边距（建议 ≥64px）；页码页脚自己排（引擎不自动加）。
- 用户给了设计参考图时，先用预览面板核对 HTML 与参考的差距再转换——改 HTML 便宜，重转也快，但一次到位最好。
`,
}
