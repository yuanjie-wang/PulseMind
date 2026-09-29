# 在线 Word（文字文档）操作手册

> `cloud-doc-ops` 分册 · 返回主索引：[`../SKILL.md`](../SKILL.md)
> 本文结论均实测于 2026-09-27/28。⚠️ 标记为高风险项，★★ 为关键提醒。

---

## 一、识别与前置

### 1.1 这是什么文档

| 特征 | 值 |
|---|---|
| 分享页 URL | `doc.cmbchina.com/f/v?id=<docId>&mode=edit` |
| **真身 URL 特征** | `wpsdoc-center-zhdoc-b.paas.cmbchina.com/weboffice/office/`**`w`**`/<id>` ← 路径含 **`/w/`** |
| 内核 | **WPS 文字**，跨域 iframe（`iframe#office-iframe`） |
| 工具栏 | 开始 / 插入 / 页面 / 审阅 / 视图 / 工具 / 协作 / 效率 |
| 状态栏 | 有 `字数 : N`（⚠️ 会撒谎，见 §2.4） |
| 正文形态 | canvas 渲染，DOM 取不到文本；**ARIA 快照可读** |

**快速判定**：真身 URL 含 **`/office/w/`** → **本文档**；含 `/office/s/` → Excel（`excel.md`）；页面**无 any iframe** → 智能文档（`smart-doc.md`）。

### 1.2 编辑模式（前置条件，错了后面全废）

- 模式按钮：显示 **`阅读`** = **可编辑**；显示 **`编辑`** = 只读（**语义反转**，主文件 §0.2）
- 顶层直连后的交叉验证（`evaluate`）：
  ```js
  return {
    isEditMode: window.APP.isEditMode,              // true
    isReadonlyOnLocal: window.APP.isReadonlyOnLocal, // false
    inReading: window.APP.isInReadingMode(),         // false
  }
  ```

### 1.3 顶层直连（推荐，高级能力的前提）

从分享页取 `iframe#office-iframe` 的 `src` → `agent.browsers.open(src)` 新标签页打开 → **跨域解除**（主文件 §0.4）。

**收益**：ref 前缀不再漂移 / `evaluate` 可自由访问主文档 DOM / `window.APP` 与 `doc.getText` 等高级能力可用。

---

## 二、读（三通道）

### 2.1 通道 A：ARIA 快照直读（最快）

```js
const snap = await t.domSnapshot({ full: true })
// iframe 内部每个段落是独立节点：
//   generic  "你好呀，"      ← 正文片段
// 状态栏 "字数 : 6" 可交叉校验（但 §2.4 有警告）
```

### 2.2 通道 B：⌘C 剪贴板（含安全取消选区）

```js
await t.keyboard.press('Meta+a')
await t.keyboard.press('Meta+c')
await t.waitForTimeout(300)
const text = await t.clipboard.read()      // → "你好呀，PulseMind～\r\r\n"
await t.keyboard.press('ArrowRight')       // ★★ 必须：立即取消残留选区 ★★
await t.waitForTimeout(200)
```

> ★★ **不取消选区的后果**（陷阱 5.3，实测删光过一篇文档）：残留选区 + `Backspace` = **静默删光全文**；残留选区 + `type()` = **静默覆盖全文**。**零报错。**

### 2.3 通道 C：`doc.getText(pos, len)`（★最干净，需顶层直连★）

```js
return await t.evaluate(() => {
  const doc = window.APP.data.doc
  const len = doc.concernRanges[0].len
  return { text: doc.getText(0, len), len }     // 一次读全文
})
```

**为什么推荐**：
- 正文主体是 `type=0` 的 subdoc（见 §五），`getText(0, len)` **一次读出**——比逐节点快照拼接、比 ⌘C 剪贴板**都干净**；
- 支持**读任意区间** `getText(pos, n)` → "定位到某位置 → 读那一段"的闭环；
- **不占用用户剪贴板**。

### 2.4 ⚠️ 状态栏「字数」会撒谎

移动光标后状态栏可能**误显 `0`**（懒计算的瞬时值），但正文完好（快照/`getText` 都能读到）。
**判定内容有无，只能读正文节点 / `getText` / 剪贴板，不能信状态栏。**（曾因此误报"内容丢失"）

---

## 三、写

### 3.1 分段写入四铁律（★踩出来的★）

| # | 铁律 | 后果 |
|---|---|---|
| **1** | 段落必须用 `Enter` 键（即 `\r`），**不能用文本 `\n`** | 换行被吞或错位，标题与正文粘连 |
| **2** | 连续键入之间**等待 700-800ms** | 太快 → **字符丢失 / 随机插入换行**（内核异步渲染跟不上）|
| **3** | `⌘A⌘C` 读完**必须立即 `ArrowRight` 取消选区** | 残留选区 + 退格 = **静默删光全文**；+ 键入 = **静默覆盖全文** |
| **4** ★新 | **写后逐行回读校验 + 收尾全文终检**（双重保险）| **逐行校验通过 ≠ 最终留存**：2026-09-29 实测 13 行逐行 ok，收尾终检仍抓到「一、」两字凭空丢失 |

#### ⚠️ 批量键入实测不可靠（2026-09-29，500+ 字 / 13 行）

**700ms 间隔分批（每批 7 行）仍丢字**，症状四类：**行首序号被吞**（「一、我为什么诞生」→「我为什么诞生」）、**整段丢失**、**段内空格变成段落符**（标题被拆两行）、**段落粘连**。
→ **500 字 / 7 行以上一律走下面的「逐行写入 + 每行回读」配方**，别再赌批量分批；写完必须全文终检。

#### ★ 正面配方：逐行写入 + 每行回读（实测 13 行全对）

```js
const lines = ['标题', '第一段', '第二段']       // 全部段落
const status = []
for (const [i, ln] of lines.entries()) {
  if (i > 0) { await t.keyboard.press('Enter'); await t.waitForTimeout(600) }
  await t.keyboard.type(ln)
  await t.waitForTimeout(1000)                   // 行内间隔宁长勿短
  const r = await t.evaluate(() => {             // ★ 每行写完立即回读
    const d = window.APP.data.doc
    const len = d.concernRanges[0].len
    return { len, text: d.getText(0, len) }
  })
  const body = r.text.replace(/\r+$/, '')        // ★★ 必须先剥文末 \r，否则校验必误判
  const ok = body.endsWith(ln)                   //   （或 split 后比段落，见下方坑 B）
  status.push({ i, ok, tail: body.slice(-18) })
  if (!ok) break                                 // ★ 失败立即停，别带着坏状态继续写
}
// 全部写完后 ★全文终检★：
//   getText(0, len) → split('\r') → 与预期段落数组逐段 diff，全 match 才算完成
```

#### ⚠️ 校验代码自身的两个坑（各误判过一次，白绕数轮）

| 坑 | 错误表现 | 正确写法 |
|---|---|---|
| **A. 文末段落符** | `getText` 返回值**以 `\r` 结尾**，`endsWith(行文字)` 永远 false → 把写成功的行误判为失败 | 先 `text.replace(/\r+$/, '')` 再比对 |
| **B. 段落索引差一位** | `text.split('\r')` 因结尾 `\r` **末尾多一个空串**，按索引比对时新行实际落在 `len-2`，读 `paras[len-1]` 得 `""` | `split('\r').filter((s,i,a)=>!(i===a.length-1 && s===''))`，或用 endsWith（坑 A 的剥法）|

**校验失败 ≠ 写入失败**：先回读全文确认文字到底在不在，再下结论——本轮两次「失败」都是校验代码自己的 bug，不是文档丢了字。

### 3.2 精准插入（★字符级，高级通道★）

坐标 = `gcp`（文档全局字符偏移量），范围 `0 ~ concernRanges[0].len`。

```js
// ① 读基线
const before = await t.evaluate(() => {
  const s = window.APP.data.selection
  return { b: s.begin.position, len: window.APP.data.doc.concernRanges[0].len }
})
// ② 定位（★★ selection 挂在 APP.data 上，不是 APP.data.doc！★★）
await t.evaluate(() => window.APP.data.selection.setPosition(100))   // → true
// ③ 真实键入（keyboard.type，不是 playwright 'fill'）
await t.keyboard.type('要插入的文字')
await t.waitForTimeout(700)
// ④ 双重对账：位置 +N、长度 +N，双双对上才算成功
const after = await t.evaluate(() => {
  const s = window.APP.data.selection
  return { b: s.begin.position, len: window.APP.data.doc.concernRanges[0].len }
})
// 例：before{100, 523} → 插 4 字符 → after{104, 527} ✅ 双双对账
```

**实测（2026-09-27）**：`setPosition(522→100)` 读回 = 100；插入 4 字符后 **位置 100→104、长度 523→527** ✅
**边界保护**：`setPosition` 源码含 `checkIfSelectionBeyondLimitation` —— 越界会被调整或拒绝，**不会写坏文档**。

### 3.3 精确选中并删除

```js
await t.evaluate(() => window.APP.data.selection.setPosition(100))
for (let i = 0; i < 4; i++) {
  await t.keyboard.press('Shift+ArrowRight'); await t.waitForTimeout(120)
}
await t.keyboard.press('Backspace')
// 验证：len 527 → 523
```

### 3.4 多位置插入一律倒序（从后往前）

若从前往后插入，**前面插入会让后面已算好的位置全部偏移**。

```js
// ① 一次读全文，拿到每个目标点的精确字符位置
const full = await t.evaluate(() => {
  const doc = window.APP.data.doc
  return doc.getText(0, doc.concernRanges[0].len)
})
// ② 从【最后一个】目标位置开始：setPosition(n) → type('新内容') → 每步回读验证
// ③ 最终再 getText 全文复核
```

**实测（2026-09-28）**：用此法补齐「一、二、三、四、五、」五个标题序号，全程走事务层、可撤销、逐步验证 ✅

### 3.5 ⚠️⚠️ 红线：禁用 `pureTextStream` 裸流写入

| 接口 | 结果 | 副作用 |
|---|---|---|
| `pureTextStream.insertText()` | "能写进去"（字符数会变）| ① **用户手动编辑随即失效**（必须刷新页面）② 留下**清不掉的不可见残留 `÷`** ③ 不进编辑事务 |
| `pureTextStream.deleteText()` | "能删掉"（字符数会变）| ⚠️ **"清理成功"是假象** —— 可见字符删了，**结构里的幽灵节点还在**（见 §5.5）|

**机制**：裸流写入**绕过事务钩子**（`onBeforeInsertText` / `onInsertText`），内核未维护 subdoc 结构 → 残留幽灵节点。详见 **§五**。

**Word 写入一律走**：键盘 `type`（§3.1）或 `setPosition` + `type`（§3.2）。**定位（setPosition）与读文字（getText）是安全的，只有"绕过事务写内容"是禁止的。**---

## 四、高级通道：内部 API 精准控制（顶层直连后）

> `window.APP` 是 WPS 编辑器核心对象，**无官方文档、属内部实现、跨版本可能变** —— **用前先探测存在性**，不要假设一定存在。

### 4.1 对象地图（Word 侧，实测）

```
window.APP
├─ data.doc                          ← 文档主体
│  ├─ concernRanges[]                ← 文档范围 [{pos, len}]（len = 文档总长）
│  ├─ subdocs[]                      ← 子文档数组（见 §五）
│  ├─ sections / bookmarks / comments / fields / findRanges
│  ├─ getText(pos, len)              ← ★读正文任意区间
│  ├─ getSubDocType / getSubDocOffset / getSubDocSize / getSubDocRange
│  ├─ getTextLengthInSubDoc / isRangeContainSubDocNode / isSubdocEmpty   ← 结构诊断
│  └─ onBeforeInsertText / onInsertText / onBeforeDeleteText / onDeleteText  ← 事务钩子
├─ data.selection                    ← ★选区/光标（★★ 在 data 上，不在 data.doc 上 ★★）
│  ├─ begin.position / end.position  ← 读光标位置
│  ├─ setPosition(n) / setRanges(...) / setBegin / setEnd
│  └─ getPosNum / getLeftTopPoint
├─ isEditMode / isReadonlyOnLocal / isInReadingMode()
├─ api                               ← 命令队列（pushCommand / queryRange / sendSelectionChange …
│  └─                                   beginBatchCommand / endBatchCommand / sendUndo / sendRedo）★未深验
├─ newRange / dispatch / view / scheduler
└─ getPosRange / getRange            ← 按位置区间取 Range（★未深验）

※ ❌ APP.undo 在 Word 侧【不存在】（Excel 有）
```

### 4.2 坐标系：`gcp`（文档全局字符偏移量）

| 概念 | 含义 | 取值示例 |
|---|---|---|
| `selection.begin.position` | 光标位置（gcp）| `522` |
| `concernRanges[0].len` | 文档总长 | `523` |
| `subdoc.subdoc_offset` | 子文档起点 | 见 §五 |
| `cp2gcp` | 子文档内偏移 cp → 全局 gcp 转换 | 方法 |

**判据：双重对账** —— 插入 N 字符后，**位置 +N 且 长度 +N**，两个数字同时对上才算成功（一个对不上 → 可疑）。

### 4.3 安全边界（实测 + 源码佐证）

| 接口 | 安全 |
|---|---|
| `setPosition(n)` | ✅ 只动光标、不改内容；源码含 `checkIfSelectionBeyondLimitation` 越界保护 |
| `begin.position` / `concernRanges` | ✅ 只读 |
| `doc.getText(pos, len)` | ✅ 只读 |
| 键盘 `type` / `Shift+方向键` / `Backspace` | ✅ 走事务层，可撤销 |
| `pureTextStream.insertText/deleteText` | ❌ 禁用（§3.5）|

### 4.4 样式回读：加粗/对齐写完怎么验证（★新配方 2026-09-29★）

**背景**：快照读不到样式；截图此路不通 —— **直连页截图直接报错**（`Page.captureScreenshot: 0 width`），分享页截图无法核对。**唯一可靠通道 = `selection.selContext`**（随选区实时变化的段落/字符属性）。

```js
// ① 选中目标行（以标题在文首为例）
await t.keyboard.press('Meta+Home'); await t.waitForTimeout(250)
await t.keyboard.press('Shift+End');  await t.waitForTimeout(400)
// ② 读格式
const r = await t.evaluate(() => {
  const c = window.APP.data.selection.selContext
  return { bold: c.chpx && c.chpx.bold, align: c.papx && c.papx.horizontal_align_mode }
})
```

| 字段 | 含义 | 实测读数 |
|---|---|---|
| `chpx.bold` | 字符加粗 | `true` = 已加粗（铁证 ✅，`bold_cs` 同步为 true）|
| `chpx.font_size_normal` | 字号（半磅值）| `210` = 五号（10.5pt）|
| `papx.horizontal_align_mode` | 段落对齐枚举 | **语义未知**：本次居中后 `2`、正文默认段 `4` |

**对齐枚举没有文档 → 用对照法，别背数值**：同文档内读「默认段 / 操作前」与「目标段 / 操作后」两个值，**差值即操作效果**（本次 ⌘E 让值 4→2 → `2` = 居中）。换文档/版本前枚举可能变，永远现测对照。

**配套快捷键（直连页实测有效）**：`Meta+Home` 文首 ｜ `Shift+End` 选至行尾 ｜ `Meta+b` 加粗 ｜ `Meta+e` 居中 ｜ `End` 收起选区（防残留选区陷阱）。

**已证实不可用的路**：`APP.api.queryRange({gcpCurrent, length})` → 恒返回 `false`。

---

## 五、Subdoc 结构模型与「幽灵 subdoc」事故

### 5.1 结构模型（实测）

`doc.subdocs` 是**数组**，每项字段：

| 字段 | 含义 |
|---|---|
| `subdoc_offset` | **起始偏移**（等价 beginPos）|
| `subdoc_size` | **长度**（等价 endPos）|
| `subdoc_type` | **类型：`0` = 正文主体**；1~7 = 本案例的异常残留 |
| `document` | 所属文档 |

原型方法：**`cp2gcp`**（子文档内偏移 → 全局位置，★`setPosition` 用的是 gcp）、`toDocumentPosition`、`getTextSize`、`contain`。

### 5.2 幽灵 subdoc 事故（2026-09-27 完整取证，523 字符文档）

| i | subdoc_offset | subdoc_size | subdoc_type | 内容 |
|---|---|---|---|---|
| 0 | 0 | 524 | 0 | **正文全文**（正常主体）|
| 1 | 524 | 1 | 1 | `÷` ⚠️ |
| 2 | 525 | 1 | 2 | `÷` ⚠️ |
| 3 | 526 | 1 | 3 | `÷` ⚠️ |
| 4 | 527 | 1 | 4 | `÷` ⚠️ |
| 5 | 528 | 1 | 5 | `÷` ⚠️ |
| 6 | 529 | 1 | 6 | `÷` ⚠️ |
| 7 | 530 | 1 | 7 | 空壳 ⚠️ |

- `total = 523`（有效文本长度） vs **`sumSize = 531`**（结构总长）→ **对不上**
- 成因：**6 次 `pureTextStream.insertText` → 6 个幽灵节点 + 1 个空壳 = 7 个残留**（每次调用在文档末尾新建一个独立 subdoc）
- 症状：编辑器结构树被搞乱 → **编辑失效**（刷新后恢复）

### 5.3 机制解释：绕过了结构维护钩子

内核存在 `onBeforeInsertText` / `onInsertText` / `onBeforeDeleteText` / `onDeleteText` **事务钩子**：

```
正规路径：键盘 type → 事务层 → 钩子触发 → 内核维护 subdoc 结构 ✅
裸流路径：pureTextStream.insertText → 直接写文本流 → 钩子未被调用
          → 结构未维护 → 文档末尾残留幽灵 subdoc ❌
```

**这是「禁用裸流写入」的根因** —— 不是"经验上会坏"，而是**机制上必然坏**。

### 5.4 只能防，不能修

- `doc.subdocs` 只是**普通 JS 数组**（有 `at/find/push/pop/splice` 等标准方法）—— **改前端数组不会同步内核子文档树**（此路不通且高风险）；
- `doc` 上**没有** `removeSubdoc` / `normalize` / `rebuild` / `repair` 之类修复 API；
- **结论：结构污染只能防（禁用裸流），不能修。**

**结构诊断 API（只读，可用于健康检查）**：
`getSubDocType` / `getSubDocOffset` / `getSubDocSize` / `getSubDocRange` / `getTextLengthInSubDoc` / `isRangeContainSubDocNode` / `isSubdocEmpty` / `limitInSubdoc`

### 5.5 ⚠️ `deleteText` 的"清理成功"是假象（主文件 §5.16）

`deleteText` 之后读数：`total:523` / `textLen:523` —— **看起来干净，实际幽灵节点仍在结构里**（§5.2 的实测就是清理后再取证的）。
**可见字符删掉了 ≠ 结构清干净了。判断清理成功不能只看 `total` / 长度读数。**

### 5.6 结构健康检查配方

```js
return await t.evaluate(() => {
  const doc = window.APP.data.doc
  const len = doc.concernRanges[0].len
  const items = []
  for (let i = 0; i < doc.subdocs.length; i++) {
    const sd = doc.subdocs[i]
    items.push({ i, off: sd.subdoc_offset, size: sd.subdoc_size, type: sd.subdoc_type })
  }
  const sum = items.reduce((a, b) => a + (b.size || 0), 0)
  return {
    total: len, count: items.length, sumSize: sum, items,
    // 简易判据（仅适用"纯正文文档"；含表格/图片的文档本来就有多个 subdoc）
    hint: (items.length === 1 && items[0].type === 0) ? '疑似健康' : '含多个 subdoc，逐一核对 type/内容',
  }
})
```

### 5.7 读全文 + 倒序插入的组合配方

见 §3.4（一次 `getText` 拿全文 → 从后往前 `setPosition` + `type` → 逐步回读 → 最终全文复核）。
**这是"多位置精确编辑"的标准流程**（实测补齐五个标题序号，全程可撤销）。

---

## 六、Word 专用自检清单

**读之前**
- [ ] 模式正确（按钮显示 `阅读` = 可编辑）
- [ ] DLP 已完成（主文件 §0.5）
- [ ] 想省事 → 顶层直连（§1.3）后用 `doc.getText(0, len)` 一次读全文
- [ ] 用剪贴板读 → **读完立即 `ArrowRight`**（§3.1 铁律 3）

**写之前**
- [ ] **确认无残留选区**（编辑前必查！）
- [ ] 想清楚写在哪：追加 / 替换 / `setPosition(n)` 精准定位
- [ ] 全篇替换 = 先 `⌘A` + 直接 `type`（不用先删）

**写之后**
- [ ] **双重对账**：位置 +N、长度 +N（§4.2）
- [ ] **逐段终检**：`getText` → split 后与预期段落数组**逐段 diff 全 match** 才算完成（★逐行校验通过 ≠ 最终留存，§3.1 铁律 4★）
- [ ] `getText` 全文复核（标题/段落有没有粘连错位）
- [ ] 改了格式（加粗/对齐）→ **`selContext` 回读验证**（§4.4），别信截图
- [ ] 出错立即 `⌘Z`；**结构异常 → 不必刷新**（刷新会丢未保存状态，先报告用户）

**收尾**
- [ ] 清理测试痕迹（自己写的标记删干净）
- [ ] 用 §5.6 做一次结构健康检查（若本轮用过可疑接口）

---

## 七、关联

- **主文件**：§0 通用层（§0.2 模式语义反转 / §0.4 顶层直连 / §0.5 DLP / §0.6 ⌘C 铁律）
- **通用陷阱**（主文件 §5）：本类型重点 —— 5.1 模式语义 / 5.3 ⌘A 残留选区 / 5.5 字数撒谎 / 5.6 前缀漂移 / 5.8 丢字符 / 5.9 `\n` 非段落符 / 5.10 evaluate 上下文 / 5.15 裸流红线 / 5.16 deleteText 假象
- **相关分册**：`excel.md`（在线 Excel）/ `sheet-multi.md`（多维表格）/ `smart-doc.md`（智能文档）
- **本手册新增内容的回流点**：幽灵节点新变体、新修复 API（若有）、`setPosition` 签名变化 → 都回写到此文件