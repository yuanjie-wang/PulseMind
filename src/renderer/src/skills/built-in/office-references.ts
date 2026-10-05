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

- **设计路线**：颜色只收不透明（半透明被点名拒绝）；渐变/CSS 变换/动画进不了 pptx；图表改数据 = 改 \`data-chart\` 标注后重转（形状不是活图表）；无母版/动画——用户公司模板的价值在母版，那走 \`office_edit\`（§四）。
- **markdown 兜底路线**：图片降级成文字（末尾追加「备注」页列损失）；无图表、无版式变化，固定 16:9。
- **两条路线都没有**：母版定制、动画、切换。

## 四、套模板（office_edit 的主场）

用户给的公司模板，价值全在母版。做法：

1. \`outline\` 拿每页的 shape_id、名称、占位符类型与原文——**先看再动**。
2. \`set_shape_text\` 逐形状重写内容。表格单元格的 id 形如 \`cell:r:c\`。
3. **段落样式继承自母版，不要覆盖。** 别顺手 \`format_text\` 改字体字号——那正是模板存在的意义。
4. **PPT 不会自动重排。** 新文本明显长于原文就会溢出文本框：拿 \`outline\` 给出的原文当标尺（PPT 没有 docx 那样的预算字段，长度得自己看），超了先换行 / 拆页 / 改措辞，再落笔。
5. 幻灯片编号、页码、日期是域（\`a:fld\`），永远不参与匹配，交给 PowerPoint 自己算。

要指定中文字体时（生成端给不了）：\`format_text\` 传 \`font\`（如 \`微软雅黑\`），引擎会同时写西文与东亚字体，中文同样生效。

## 五、配色与字号

- 设计路线的配色由 tokens.css 一处驱动（§七 §1）；图表主色取 \`--pm-accent\`，先骑系列色首位。
- \`office_edit\` 手工样式时：颜色写 6 位 \`RRGGBB\` 不带 \`#\`；字号阶梯（pt）封面主标题 40–44 / 页标题 28–32 / 要点 18–22 / 注释与来源 12–14；一套 deck 最多 2–3 个强调色，正文近黑（\`262626\`），强调色只给标题或关键数字。
- 底色 / 形状色用 \`set_shape_fill\`（\`"none"\` 表示无填充）、\`set_slide_background\`；位置尺寸用 \`set_shape_geometry\`（单位**英寸**）。
- 样式类算子不允许改变可见文字——引擎会在文字被改动时拒绝整批。这是防"改样式顺手把内容改没了"的护栏，不是限制。

## 六、交付前

- 封面有信息（标题 / 副标题）；每页都有标题，没有一页只剩一行；结尾不要留空「谢谢」页。
- 设计路线的图片必须先存在于工作区（html 里相对路径引用，png/jpg/gif）；转换成功结果带保真报告，交付时如实转述降级项。
- markdown 兜底路线追加的「备注」页（列降级损失）在回复里提一句，别让它莫名出现在成品末尾。
- 数字页（图表/表格/大数字）的口径与来源写在页脚或回复里说明。

## 七、设计路线（htmlPath：HTML → pptx）

这是从零做 PPT 的**唯一生成路线**。四步：**风格对齐**（与用户确认，不要跳过）→ \`write\` tokens.css（主题落定）→ \`write\` deck.html（版式与内容）→ \`export_document\`（format pptx + \`htmlPath\`）。引擎用 Chromium 实测布局后输出**原生可编辑形状**（不是截图），产物预览与 HTML 一致。

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

**能用**：h1–h6、p、ul/ol/li（真项目符号，嵌套 ≤2 层）、table（th/td，逐格底色字号生效）、img（工作区 png/jpg/gif，相对路径）、div/span（色块卡片：background/border/border-radius 都映射）、b/strong/i/em/u/s、布局用 absolute 或流式 + flex；字号（引用 var(--pm-fs-*)）字色、行高、对齐、等宽（font-family 只许 var(--pm-font-mono) 等三个字体变量）按浏览器实测落。960×540 @96dpi ≡ 10×5.625 英寸，浏览器里的 1px 在 pptx 里是 0.75pt。

**禁用（会整单拒绝）**：\`<script>\`、@font-face、svg/iframe/video/canvas 等白名单外元素；渐变（背景只收纯色）；半透明色（rgba α<1——需要浅色给 --pm-accent-soft 或调淡后的 hex）；transform / position:fixed / CSS 动画；在 HTML 里写字体名（font-family 只允许 var(--pm-font-…) 引用）；网络或内联资源（src 只能工作区文件）；表格 colspan/rowspan。**内容超出 960×540 也拒绝**——装不下就缩小或拆页。**两段文字的框相交也会拒绝**并点名两个元素——绝对定位按实际渲染高度排，拿不准就把下方元素多留一行高。box-shadow / opacity / 虚线边框映射不了，会在保真报告里如实列出，不静默丢弃。转换器已把文本框内边距清零并按对齐方向加了少量安全余量（右对齐向左扩、左对齐向右扩，锚点不动）——html 里量出的位置就是 pptx 里的位置，页码这类窄文本框不会因此折行。

**图表用标注，不要画 SVG**——引擎按 deck 同款词汇画原生形状（PowerPoint 里可改色改字，改数据 = 改标注后重转）：

\`\`\`html
<div data-chart='{"type":"column","categories":["Q1","Q2","Q3"],"series":[{"name":"营收","values":[120,135,158]}]}'
     style="position:absolute; left:64px; top:120px; width:600px; height:360px"></div>
\`\`\`

图表 JSON 与 deck 的 chart 字段同一 schema：type 取 column/bar/line/pie；categories 2–12 个；series 1–4 组与 categories 等长；pie 只吃一组且非负。

### 3. 转换与交付

- \`export_document\`（format pptx、htmlPath 指向 deck.html、file_path 给成品名）。**先 write 完 tokens 与 html 再调用**；profile 校验拒绝残缺 HTML 时按报错修完重试。
- 成功结果带**保真报告**（每页块数 + 降级清单）——交付时如实转述给用户。
- **双源契约**：HTML 是创作源——改版式/换主题 = 改 tokens.css 或 deck.html 重新导出；**交付后的小改走 office_edit**，不要改了 HTML 就重转（会丢掉已在 pptx 上做过的 office_edit 修改）。

### 4. 设计 checklist（交付前）

- 每页一个视觉重心：大标题 / 大数字 / 一张图；不要三栏小字挤一页。
- 取色一律 var(--pm-*)，别硬写 hex——用户换品牌色才不用重写 HTML。
- **强调色纪律**：accent 只给焦点元素（标题短条、章节编号、关键数字、图表主色），单页面积 ≤10%，禁止大面积铺色；浅色强调用 --pm-accent-soft。
- **节奏**：全篇至少 2–3 页显著不同（满版反白/大图 vs 常规白底），别 14 页一个模子；章节扉页、封面、结束页可以放开做满版。
- **密度与呼吸**：视觉锚点周围 ≥40px 空白；卡片内容占满容器（别只有半截字吊着）；横向并排的卡片标题基线对齐。
- 字号走 var(--pm-fs-*) 阶梯（改阶不改 HTML）；页脚/页码惯例：右下 \`var(--pm-font-mono)\` + \`--pm-fs-note\`，写 \`3 / 14\` 样式；封面与结束页不放页码。
- 逐元素 absolute 时留页边距（建议 ≥64px）；页码页脚自己排（引擎不自动加）。
- 用户给了设计参考图时，先用预览面板核对 HTML 与参考的差距再转换——改 HTML 便宜，重转也快，但一次到位最好。
`,
}
