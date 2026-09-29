---
name: cloud-doc-ops
description: 招商银行云文档（doc.cmbchina.com）总索引与通用层：四类文档（在线 Excel / 多维表格 / 在线 Word / 智能文档）的类型识别方法、reference/ 分册使用说明与地址、跨域 canvas 内核通用操作（顶层直连 / ⌘C 取数 / 内部 API 安全边界）、陷阱清单与操作检查单。动手前先读本文件，按识别结果加载对应分册。
category: automation
triggers:
  - 云文档
  - doc.cmbchina.com
  - 在线Excel
  - 在线Word
  - 在线文档
  - 多维表格
  - 智能文档
  - 招行文档
  - WPS
  - weboffice
---

## Active Skill: 云文档操作（doc.cmbchina.com）

> **本文件 = 总索引 + 通用层。** 四类文档的详细操作手册在 `reference/` 分册（见 **§2 分册索引**）。
> **工作流（照此执行）**：① **§1 识别文档类型** → ② **§2 加载对应分册** → ③ **§0 过一遍通用层** → ④ 操作中常查 **§5 陷阱清单**。

招行云文档基于 WPS 内核。**在线 Excel / 多维表格 / 在线 Word 跑在跨域 iframe 里（`*.paas.cmbchina.com`），智能文档不跨域。**
每条通道都标注了验证状态：✅ 已实测 ｜ ⚠️ 未实测/有条件。

**核心前提：所有读写都建立在「已登录 + 已进入可编辑态」之上。这两步错了，后面全废且不报错。**

---

### §0 通用层

#### 0.1 SSO 登录（必须用户本人操作）

任何 `doc.cmbchina.com/f/v?id=xxx` 分享链接，未登录会被 **招乎统一认证中心**拦截（`oa-auth.paas.cmbchina.com/auth/sso-login`）。

| 项 | 说明 |
|---|---|
| 默认方式 | 招乎 APP 扫码 |
| 备选 | 展开「其他登录方式」→「**验证码登录**」（手机号/邮箱 + 短信验证码）|
| **铁律** | **扫码与验证码必须用户本人完成，助手不代填、不代扫、不索要凭证** |
| 助手能做 | 把「其他登录方式」面板点出来 |
| 通过后 | 标签页自动跳回文档页 |

#### 0.2 编辑模式（★语义与直觉相反★）

右上角有 `阅读` / `编辑` 按钮。**标签表示"当前状态"，不是"点它能做什么"**：

| 按钮显示 | 实际状态 | 能否编辑 |
|---|---|---|
| **`阅读`** | **当前是编辑态** | ✅ 能写 |
| **`编辑`** | **当前是只读态** | ❌ 不能写，需点它切换 |

> **血泪**：此语义读反过两次，导致「键盘没反应／鼠标点不进正文／快捷菜单不弹」三连误判，白绕 8 次调用。
> **凡"操作无效"，第一个查这里。**

**例外**：Word 在「顶层直连」页面下（§0.4）可能无需切换即可编辑 —— 用 `APP.isReadonlyOnLocal / isEditMode` 直接判定（详见 `reference/word.md` §4），比看按钮更可靠。

#### 0.3 跨域 iframe 的边界

> **例外**：**在线智能文档不跨域**（主文档直接渲染），本节限制对**它不适用**。详见 `reference/smart-doc.md`。

| 能力 | 跨域 iframe 内部 | 主框架 / 顶层页 |
|---|---|---|
| `domSnapshot` 读取 | ✅ 可以（ref 带 `f<数字>e<数字>` 前缀）| ✅ |
| Playwright 定位器 | ❌ **不可用**（超时）| ✅ |
| `contentDocument` / `getBoundingClientRect` | ❌ `null`（跨域封死）| ✅ |
| 真实键盘事件 | ✅ **可以**（内核在 iframe 内监听全局键盘）| ✅ |
| ref 前缀稳定性 | ⚠️ **会漂移**（f7→f11，随重渲染变）| ✅ 纯 `eNN`，稳定 |

**铁律**：
1. **每次操作前重新读快照、重新解释前缀**，绝不复用旧的 `f` 前缀。
2. **跨域墙的判定主体是"谁访问谁"** —— 站在 A 域读 B 域才跨域；**直接站在 B 域上，B 域即同源**。

#### 0.4 ★★ 跨域绕行方案：顶层直连（重要突破口）★★

**原理**：跨域限制约束的是「从 A 域读 B 域」。若把编辑器**本身**升为顶层页面，则**编辑器的一切对助手同源**。

**做法**：从主文档 DOM 取 iframe 真身 URL，用 `open()` 新标签页直连。

```js
// 取真身 URL
await t.evaluate(() => document.querySelector('iframe#office-iframe')?.src)
// → https://wpsdoc-center-zhdoc-b.paas.cmbchina.com/weboffice/office/w/<fileid>?_w_appid=..&_w_third_wo_info=..
// 然后
await agent.browsers.open(thatUrl)
```

**顶层直连后的收益**：
| 项 | iframe 内 | 顶层直连 |
|---|---|---|
| ref 前缀 | 会漂移 | ✅ 纯 `eNN` |
| 定位器 / 坐标 | ❌ | ✅ |
| `window.APP` 内部 API | ⚠️ 未见 | ✅ **可用**（Word 高级通道全部能力的前提，详见 `reference/word.md`）|

**⚠️ 风险与合规**：
- `_w_third_wo_info` 是**带身份凭证的临时 token**，**有时效**。
- **不作为对外操作的常规手段**；仅用于自有/测试文档的能力验证与自动化。
- 该地址是**同一份文档的另一个入口**（非伪造凭证），但直连仍可能跳过外层页面的权限校验，**注意合规边界**。

#### 0.5 DLP 安全扫描（通用前置关卡，会卡住内容加载）

打开云文档时常见状态：`DLP 安全扫描中...请耐心等待`。

| 现象 | 说明 |
|---|---|
| `iframeCount: 0`、正文不加载 | **扫描未完成，内核未创建** |
| 出现范围 | **非智能文档独有** —— Word 同样出现（**更正旧结论**）|
| 处置 | 等待，或请**用户手动放行**；**助手无法绕过 DLP**（安全策略，非技术边界）|
| 判定完成 | 目录树已渲染 ≠ 正文就绪；以 **iframe 出现 / 正文节点出现**为准 |

#### 0.6 ⌘C 铁律（macOS）

| 键 | 结果 |
|---|---|
| **`Meta+c`（⌘C）** | ✅ 正常复制 |
| `Control+c` | ❌ **静默失败** —— 不报错、剪贴板纹丝不动 |

> 曾据"Ctrl+C 无效"错误推出「跨域 iframe 送不进键盘/剪贴板」的结论 —— **该结论是错的**，错在没控制键位变量。**跨域 iframe 完全收得到键盘事件。**

#### 0.7 验证铁律（写入后必须回读）

**`domSnapshot` 判不了写入成败**（tippy 编辑层不入快照；表格单元格的可访问名是坐标 `r1,f1` 而非内容）。
**唯一可靠的验证：读回**（⌘C 剪贴板 / 正文快照节点 / 位置+长度双重对账，后者详见 `reference/word.md`）。

---

### §1 ★文档类型识别（动手第一步）★

> **每一步操作前先做这一步。** 类型认错 = 整套配方全错。本节能用**三个只读观察**在 1 次调用内定类型。

#### 1.1 三步识别法

**Step 1｜先看页面级状态**
- 出现 `DLP 安全扫描中...` → 先等扫描完成（§0.5），期间任何读都是空。
- 未登录 → 先走 SSO（§0.1，用户本人操作）。

**Step 2｜判 iframe（最硬的判据）**
```
t.evaluate(() => document.querySelectorAll('iframe').length)
```
- **`iframeCount === 0`** → ⭐ **在线智能文档**（四类中唯一"非跨域"，一切常规手段可用）
- **有 `iframe#office-iframe`** → 跨域类（Excel / 多维表格 / Word 三选一），走 Step 3

**Step 3｜跨域类内部区分（读一次快照即可）**

| 你在快照里看到 | 类型 |
|---|---|
| **名称框**（`textbox`，值形如 `B9`）+ **公式栏** | **在线 Excel** |
| 单元格可访问名形如 **`r1,f1`** | **多维表格** |
| **字数统计**（`字数 : N`）、正文是普通文本段落 | **在线 Word** |

**兜底交叉验证**：Word 真身 URL 路径含 **`/office/w/`**（已实测 ✅）；其余类型路径未逐一验证。

#### 1.2 判据速查表

| 判据 | 在线 Excel | 多维表格 | 在线 Word | 智能文档 |
|---|---|---|---|---|
| 跨域 iframe | ✅ 有 | ✅ 有 | ✅ 有 | ❌ **无** |
| 名称框 | ✅（`B9`）| — | ❌ | ❌ |
| 公式栏 | ✅ | — | ❌ | ❌ |
| 字数统计 | — | — | ✅（`字数 : N`）| ✅（`N字`）|
| 单元格可访问名 | `textbox "B9"` | **`r1,f1`** | — | — |
| 正文节点形态 | canvas | canvas | 文本段落 | **`paragraph`** |
| 编辑模式按钮 | 有 | 有 | 有 | 有 |
| 内部 API 入口 | `APP.workbook` | 未探 | `APP.data.doc` | 未探（非跨域，多半不需要）|

#### 1.3 识别后的动作

```
识别结果 → 加载分册（§2）→ 分册内先读该类型「前提/前置」节 → 按分册配方操作
```

---

### §2 分册索引（识别后按此处加载）

> 分册用 `read` 工具读取。**地址相对本技能目录**（`~/.pulsemind/skills/cloud-doc-ops/`）。
> 每个分册自带：前置条件 / 读配方 / 写配方 / 代码 / 自检清单 / 关联。

| 类型 | 分册地址 | 一句话要点 + ★关键前置★ |
|---|---|---|
| **在线 Excel** | `reference/excel.md` | 能力最全：API 读（`getRangeContents`）/ API 写（`setValue2`，可撤销不污染）/ 读公式。★红线：`cell.setValue` 禁用★ |
| **多维表格** | `reference/sheet-multi.md` | ★**必须先切编辑模式**才能写★；坐标寻址 `r1,f1`；回读只能靠剪贴板（无 API 读值）|
| **在线 Word** | `reference/word.md` | ★★双通道：基础（键盘 type）+ 高级（`setPosition` 字符级精准定位）★★ ★红线：禁用裸流 `pureTextStream`★ |
| **在线智能文档** | `reference/smart-doc.md` | **四类中最好操作**：无跨域，定位器/快照直用。注意 DLP 前置 + 别把跨域技巧带进来 |

**分册内常用锚点**（打开后直接跳到）：
- excel.md → §1.1 API 读 / §2.1 正规写（setValue2）/ §3 自检
- sheet-multi.md → 编辑模式 / 坐标读写配方 / 自检
- word.md → §3.1 写入四铁律（逐行写入+回读配方）/ §4 高级通道（对象地图 / 坐标系 / 精准配方）/ §4.4 样式回读（selContext）/ §5 陷阱 / §6 检查单
- smart-doc.md → 读写配方 / 自检（**照最朴素路径走**）

---

### §3 通用操作片段（跨类型复用，可直接粘进 browser 工具）

> **通用注意**：
> - `evaluate(fn)` 的**回调体在浏览器执行**，**回调外的代码在 Node 执行** —— `window` 只能在回调内使用。
> - **回调体跑在页面上下文，页面有 `setTimeout`** —— 批量逐格写入的 `await sleep(ms)` 直接写在回调内即可（实测可用）；"沙箱无 setTimeout" 只指 Node 侧，Node 侧等待用 `t.waitForTimeout(ms)`。
> - **`t.evaluate(fn, data)` 的传参可能静默丢失**（第二参在回调里变 `undefined`，报 `Cannot read properties of undefined`）—— **要写入的数据一律内联进回调函数体**，别依赖传参。
> - **evaluate 返回值必须可序列化**：内核对象（Range/Sheet/subdoc…）整体 return 会报 `object reference chain is too long` —— 摘标量字段/纯数组再返回。
> - 每轮先用 `tabs.list()` + 过滤 URL 重新 rebind 标签页，**不要复用旧 tab id**。
> - **`tabs.get(id)` 返回句柄前必须 `await`**：`const t = await agent.browsers.tabs.get(id)` —— 不 await 直接链 `.evaluate()` 会报 `evaluate is not a function`（2026-09-29 实测踩过）。
> - 各类型专用片段已并入对应分册；本节只保留**跨类型通用**的 4 段。

#### 片段 A. 探测内部 API 是否存在（用前必做）

```js
const t = await agent.browsers.tabs.get(<tabId>)
const probe = await t.evaluate(() => {
  const A = window.APP
  if (!A) return { ok: false, reason: 'window.APP 不存在（可能未顶层直连 / 版本不同）' }
  const s = A.data && A.data.selection
  return {
    ok: !!(s && typeof s.setPosition === 'function'),
    isEditMode: A.isEditMode,
    isReadonlyOnLocal: A.isReadonlyOnLocal,
    hasSetPosition: typeof (s && s.setPosition),
    hasConcernRanges: !!(A.data.doc && A.data.doc.concernRanges),
    fileId: A.fileId,
  }
})
return probe
```

#### 片段 B. 取 iframe 真身 URL 做顶层直连

```js
// 在 doc.cmbchina.com 页面
const src = await t.evaluate(() => {
  const f = document.querySelector('iframe#office-iframe')
  return f ? f.src : null
})
// 之后
const top = await agent.browsers.open(src)
await top.waitForTimeout(1500)
return { opened: top.opened, url: src.slice(0, 120) }
```

#### 片段 C. ⌘C 读全文（含安全取消选区，★防 5.3 陷阱★）

```js
await t.keyboard.press('Meta+a')
await t.keyboard.press('Meta+c')
await t.waitForTimeout(400)
const text = await t.clipboard.read()
await t.keyboard.press('ArrowRight')     // ★★ 必须：取消残留选区，否则后续编辑会删光/覆盖全文 ★★
await t.waitForTimeout(200)
return { text, len: text.length }
```

#### 片段 D. 一次读全文（Word 正文）+ 结构健康检查

```js
const t = await agent.browsers.tabs.get(<tabId>)
return await t.evaluate(() => {
  const d = window.APP.data.doc
  const len = d.concernRanges ? d.concernRanges[0].len : null
  let full = null
  try { full = d.getText(0, (len || 0) + 1) } catch (e) { full = 'getText failed: ' + e.message }
  const subs = []
  try {
    const sd = d.subdocs
    for (let i = 0; i < sd.length; i++) {
      subs.push({ i, type: sd[i].subdoc_type, off: sd[i].subdoc_offset, size: sd[i].subdoc_size })
    }
  } catch (e) { subs.push({ err: e.message }) }
  const ghosts = subs.filter(s => s && s.type !== undefined && s.type !== 0)
  return { len, subdocCount: subs.length, ghostCount: ghosts.length, subs, head: full && full.slice(0, 80) }
})
// ghostCount > 0 → 结构已被污染（详见 word.md 幽灵 subdoc 节），标记待报告
```

---

### §4 内部 API 安全总览（红黑榜）

> 汇总四类实测结论。**动手前扫一眼**。详细出处见各分册与 §5。

| 状态 | API / 操作 | 适用 | 说明 |
|---|---|---|---|
| ✅ | `keyboard.type` / `Enter` | 通用 | 事务层写入；可撤销；节奏需 700-800ms（5.8）|
| ✅ | `setPosition(n)` | Word | 字符级定位；有越界保护 |
| ✅ | `Shift+ArrowRight` ×N + `Backspace` | Word | 精确选中并删除 |
| ✅ | `ArrowRight` | 通用 | 取消选区（纪律动作，防 5.3）|
| ✅ | `range.setValue2()` | Excel | **Range 层**写入；可撤销、不污染（`APP.undo`）|
| ✅ | `APP.undo / redo` | Excel | 正规撤销；**Word 侧不存在此 API** |
| ✅ | `getText` / `getRangeContents` / `getCell().getValue().getValue()` | 读 | 只读，安全（注意 5.12 延迟、5.13 空格）|
| ❌ | `pureTextStream.insertText / deleteText` | Word | **红线**：污染会话 + 不可见残留（5.15）|
| ❌ | `cell.setValue()` | Excel | **红线**：污染会话，需刷新（5.11）|
| ⚠️ | `cell.setFormula()` / `setFormula2` | Excel | 存在；未验证，谨慎 |
| ⚠️ | `⌘A` 后不清选区就编辑 | 通用 | 静默覆盖/删光全文（5.3）|

**统一规律（比单条红线更值钱）**：
> **"看起来能写" ≠ "能安全地写"。判据是"在哪一层"** —— 事务层（键盘 / `setPosition` / `setValue2`）安全；**绕过编辑事务的裸数据/裸流层（`cell.setValue` / `pureTextStream`）必污染**。

---

### §5 陷阱清单（全部实测量得）

| # | 陷阱 | 现象 | 规避 |
|---|---|---|---|
| **5.1** | **模式语义反转** | 看 `阅读` 才能编辑，看 `编辑` 反而只读 | 先看按钮标签再动手（§0.2）|
| **5.2** | **Ctrl+C 静默失败** | macOS 上按 Ctrl+C，剪贴板毫无变化 | 一律用 **Meta+c**（§0.6）|
| **5.3** | **⌘A 残留选区（最危险）** | 鼠标选区的残留 + 退格/键入 = **静默删光/覆盖全文，零报错** | **读完立即 `ArrowRight`**；编辑前确认无选区 |
| **5.4** | **`activeElement` 是伪标尺** | 永远是 `IFRAME` 外壳，Excel 成功时也如此 | **不要用它判成败**（详见 `reference/excel.md` 旧方案节）|
| **5.5** | **状态栏字数会撒谎** | 移动光标后误显 `0`，正文其实完好 | 读正文节点/剪贴板，别信字数（详见 `reference/word.md`）|
| **5.6** | **iframe ref 前缀漂移** | f7 → f11，随重渲染变化；用旧前缀定位必失败 | 每轮重新读快照、重解前缀（§0.3）|
| **5.7** | **DLP 卡住加载** | `DLP 安全扫描中...`，`iframeCount:0` | 等待 / 请用户放行；**非智能文档独有**（§0.5）|
| **5.8** | **连续键入丢字符（700ms 也不保险）** | 节奏太快 → 字符丢失、随机插入换行；**2026-09-29 实测：700ms 分批（每批 7 行）仍丢行首序号 / 整段丢失 / 空格变段落符** | 每步等 **700-800ms**；**500 字或 7 行以上 → 逐行写入 + 每行回读**（`reference/word.md` §3.1 正面配方）|
| **5.9** | **`\n` 不是段落符** | 一次性 type 含 `\n` → 换行错乱 | 用 `Enter`（`\r`）分段（`reference/word.md` 写入节）|
| **5.10** | **`evaluate` 内外上下文混淆** | 在 `evaluate(fn)` **外面**写 `window.APP` → `ReferenceError: window is not defined` | **`window` 的取值必须全部写在 `evaluate` 回调内部**（§3）|
| **5.11** | **`cell.setValue()` 污染编辑器** | Cell 层写入后**用户手动编辑也失效**，必须刷新页面 | ❌ **禁用** —— 要写值用 `range.setValue2()`（`reference/excel.md` §2.1，Range 层，可撤销、不污染）|
| **5.12** | **Excel API 读取有延迟** | 写完后立刻读拿到**旧值** → 误判"没写进去" → **重复写两遍** | 写完 `waitForTimeout(1000+)` 再读（`reference/excel.md`）|
| **5.13** | **`getCell` 空白格返回 `undefined`** | 对空格调 `.isEmpty()` → `Cannot read properties of undefined` | 先判 `cell` 是否存在，再判 `isEmpty()`（`reference/excel.md`）|
| **5.14** | **`getLastRow/Col` 是理论边界** | 返回 `1048575 / 16383`（Excel 最大行列），**不是**数据范围 | 数据范围用 **`getUsedRANGE()`** 取（`reference/excel.md` §1.1）|
| **5.15** | **⭐ Word 裸流层写入污染状态（红线）** | `pureTextStream.insertText()` **能写进去**，但 ① **用户手动编辑随即失效**（必须刷新页面）② **留下清不掉的不可见残留 `÷`**（超出 `rangeLen`、渲染层看不见）③ 写入**不进编辑事务**（`APP.undo` 在 Word 侧不存在）| ❌ **禁用 `pureTextStream.insertText` / `deleteText`**。**规律：凡"看起来能写、但绕过编辑器事务机制"的接口，都会污染会话状态**（Excel `cell.setValue` 同此）。Word 写入一律走**键盘 type**，定位用 `setPosition`（`reference/word.md` §4）|
| **5.16** | **`deleteText` 的"清理成功"是假象** | `deleteText` 后 `total` / `textLen` 读数恢复正常，**但幽灵 subdoc 仍留在结构里** —— `total` 只反映有效文本长度，**不反映结构健康度** | 判断清理成功**不能只看长度读数**；用 `isSubdocEmpty` / `getSubDocType` 做结构健康检查（`reference/word.md`）|
| **5.17** | **别把跨域技巧带进智能文档** | 智能文档**不跨域**：定位器直接可用、无前缀漂移、无坐标问题 —— 照搬跨域三件套（顶层直连 / 前缀处理 / 坐标换算）是画蛇添足，反而添乱 | 智能文档走**最朴素路径**：快照 + 定位器点击 + type（`reference/smart-doc.md`）|
| **5.18** | **回读校验代码自身的坑（误判「写失败」）** | `getText` 返回值**以 `\r` 结尾**：`endsWith(行文字)` 永远 false、`split('\r')` 末尾多一个空串导致**段落索引差一位** → 把写成功的行误判成失败，白绕数轮 | 比对前先 `text.replace(/\r+$/, '')`；★**校验失败 ≠ 写入失败**，先回读全文再下结论★（`reference/word.md` §3.1 坑 A/B）|
| **5.19** | **格式（加粗/对齐）验证别靠截图** | 快照读不到样式；直连页截图报 `Page.captureScreenshot: 0 width`，分享页截图无法核对 | 回读 **`selection.selContext`**：`chpx.bold`（加粗铁证）、`papx.horizontal_align_mode`（对齐；**枚举语义用同文档默认段对照法**，别背数值）（`reference/word.md` §4.4）|
| **5.20** | **逐行校验通过 ≠ 最终留存** | 每行写后回读都 ok，收尾终检仍发现丢字（实测「一、」两字凭空消失） | 写完**必须全文终检**：`getText` → split → 与预期段落数组**逐段 diff 全 match** 才算完成（`reference/word.md` §3.1 铁律 4）|

---

### §6 操作检查单

**读之前**
- [ ] 已登录（SSO 由用户完成）
- [ ] **识别文档类型（§1 三步识别法）→ 加载对应分册（§2）**
- [ ] 若为跨域类且需**高级能力**：考虑顶层直连（§0.4）
- [ ] DLP 已完成（正文 iframe 或节点已出现）

**写之前**
- [ ] 确认处于可编辑态（按钮 `阅读`／`APP.isReadonlyOnLocal === false`；**Excel 直连页这俩字段是 undefined → 改用单格探针试写**，见 `reference/excel.md` §〇）
- [ ] **确认没有残留选区**（如有，先 `ArrowRight` 或点击别处）
- [ ] 想清楚"写在哪"：追加 / 替换 / **精准定位**（`reference/word.md` §4）
- [ ] **批量写**：不传二维数组、不同 tick 连写 —— 走逐格 + ≥300ms 配方（`reference/excel.md` §2.1），数据内联进 evaluate 回调

**写之后**
- [ ] **回读验证**（⌘C / 快照 / 位置+长度对账）；★**校验失败 ≠ 写入失败**，先回读全文再下结论（5.18）★
- [ ] **Word 大段写入 → 全文逐段终检**（逐行通过 ≠ 留存，5.20）
- [ ] 改了格式（加粗/对齐）→ **`selContext` 回读验证**（5.19，别信截图）
- [ ] 检查段落结构是否完整（标题有没有粘到正文）
- [ ] 出错立即撤销（⌘Z；Excel 亦可用 `APP.undo`）

**收尾**
- [ ] 清理测试痕迹（自己写的标记要删干净）
- [ ] 发现新的坑 / 更正旧结论 → **回流本技能（§7 回写表）**

---

### §7 分册维护与回写点

> 旧 §7/§8/§9 的内容已并入分册与本文件 §3/§4。

| 分册 | 回写点（出现以下变化时更新） |
|---|---|
| `reference/excel.md` | 新 API 发现、`setValue2` 行为变化、读取延迟变化、`getUsedRANGE` 结构变化 |
| `reference/sheet-multi.md` | 编辑模式行为、坐标寻址方式、回读通道变化 |
| `reference/word.md` | 幽灵节点新变体、新修复 API（若有）、`setPosition` 签名变化 |
| `reference/smart-doc.md` | DLP 行为变化、编辑模式按钮语义变化 |
| **本文件** | 类型识别判据变化（新类型/新特征）、新通用陷阱（§5）、红黑榜增删（§4）|

**版本记录**：
- v8（2026-09-29）：Word 整篇重写任务实测回流 —— ① §5.8 升级：**700ms 分批仍丢字**（序号被吞/整段丢/空格变段落），500 字或 7 行以上改**逐行写入 + 每行回读**（word.md §3.1 升为四铁律 + 正面配方 + 校验代码两坑）② 新增 **5.18**（校验代码自身的坑：文末 `\r` / 段落索引差一位 → 校验失败≠写入失败）、**5.19**（格式验证走 `selContext.papx/chpx` 对照法，word.md 新增 §4.4；`queryRange` 恒 false 不可用）、**5.20**（逐行通过≠留存，收尾全文终检）③ §3 通用注意补「`tabs.get` 必须先 await」④ §6 检查单补终检与格式回读项。
- v7（2026-09-29）：实测回流 —— excel.md 新增 §2.4 清空配方、批量写正面配方（逐格+300ms），修正 getUsedRANGE 返回值序列化、Excel 直连页编辑态判定（isEditMode/isReadonlyOnLocal 为 undefined，改单格探针）；本文件 §3 通用注意补「回调内 setTimeout 可用」「evaluate 传参静默丢失」「返回值必须可序列化」三条。
- v6（2026-09-28）：主文件拆分为「总索引 + 通用层」，四类详细手册迁入 `reference/` 四份分册；新增 §1 类型识别、§2 分册索引；陷阱补至 5.17；新增 §4 红黑榜。