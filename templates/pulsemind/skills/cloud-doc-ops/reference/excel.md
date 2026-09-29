# 分册 · 在线 Excel（普通表格）

> **主索引**：`../SKILL.md`（或 `~/.pulsemind/skills/cloud-doc-ops/SKILL.md`）
> **通用前提**（登录 / 模式语义 / 跨域边界 / 顶层直连 / DLP / ⌘C 铁律 / 验证铁律）**见主文件 §0，动手前先过一遍。**
> 实测环境：`doc.cmbchina.com`（WPS 表格内核），2026-09-27 全程实测。

---

## 〇、识别特征 —— 怎么判断"这篇是在线 Excel"

| 层 | 判据 |
|---|---|
| **文件名 / 标题** | 形如 `新建Excel表格.xlsx`（标题含 `.xlsx` / `.xls` / "Excel"）|
| **UI** | 有**名称框**（值形如 `B9`）+ **公式栏**；工具栏含「开始 / 插入 / 数据 / 公式 / 协作 / 视图 / 效率」 |
| **快照** | 单元格文本**不在 DOM**（canvas 渲染）；名称框是 `textbox "B9"` 形态 |
| **JS（顶层直连后）** | `window.APP.workbook` 存在且 `getActiveSheet()` / `getWorksheets()` 可用 |
| **iframe** | 跨域 `iframe#office-iframe` 存在（非智能文档）|

> **与 Word 的区分关键**：**有名称框与公式栏 = Excel**；**`APP.data.doc` / `subdocs` / `sections` 可用 = Word**。

> ★ **编辑态判定（2026-09-28 实测更正）**：Excel 顶层直连页上 **`APP.isEditMode` / `APP.isReadonlyOnLocal` 全是 `undefined`**（这俩是 Word 侧字段），probe 只会有 `ok`/`hasWorkbook` —— **别拿它们判 Excel 编辑态**。可靠顺序：① 外层页看按钮语义（主文件 §0.2，`阅读` = 编辑态）；② 直连页 → **单格探针试写**（写 `'PROBE'` → 回读 → 成功即编辑态，写完删掉探针）。探针同时兼做"批量写前置排除法"（§2.1）。

---

## 一、读

### 1.1 方案 A：内部 API 读（推荐 —— 不碰剪贴板、不依赖键盘焦点）

> 前提：**顶层直连**（主文件 §0.4）后 `window.APP` 可用。
> 内部 API **无官方文档、跨版本可能变** —— **用前先探测存在性**（主文件 §3 片段 A）。

**对象层次（实测）**：

```
APP.workbook                       ← 工作簿（对应 Word 的 APP.data.doc）
  ├─ getActiveSheet()              ← 活动工作表
  ├─ getWorksheets() / getWorksheetById()   （返回类数组，不能 .slice）
  ├─ getCalcService()              ← 公式计算引擎
  └─ getBmp() / getLastRow() / getLastCol()
       ⚠️ 返回【理论最大边界】(1048575 / 16383)，不是真实数据范围

Sheet（getActiveSheet 的返回值）
  ├─ getCell(row, col)             ← ★取单元格★ 参数【0-based 两个数字】
  │     ⚠️ 传 'A1' 字符串返回 null；⚠️【无数据的空白格返回 undefined】
  ├─ createRANGE(r1, c1, r2, c2)   ← ★★★ 四个数字直接构区域（坐标定位的正规做法）★★★
  ├─ createRange(...)              ← 包装成 Range 对象
  ├─ getUsedRANGE()                ← ★★★ 真实数据范围 {rowFrom,rowTo,colFrom,colTo} ★★★
  │     ⚠️ 偶发失败；失败就退到「名称框 + ⌘C」（§1.2）
  ├─ appendData                    ← 批量追加（未验证）
  └─ getCoreObject()               ← 组件树节点，【不是】数据容器

Range（createRange / createRANGE 的返回值）
  ├─ getRangeContents()            ← ★★★ 批量读：Promise → {result:{Values:[[…]]}} 二维数组 ★★★
  ├─ queryRangeValues(cb, max=3000)← 异步批量读（回调式）
  ├─ getActiveCellValue()          ← 同步读活动格字符串
  ├─ hasContent() / getValue2()    ← 区域是否非空（同步）／ 超大区域分批读
  ├─ setValue2(值, 回调)           ← ★★★ 正规写：execCmdWithConfirm，【可撤销】★★★
  └─ 几何：contain / isContain / intersect / union / cellsCount / width / height / isSingleCell

Cell（getCell 的返回值，仅非空格才有）
  ├─ getValue()                    ← ⚠️ 返回【包装对象】，须【再取一层】：getValue().getValue()
  ├─ getValueLiteral()
  ├─ getFormula()                  ← ★读公式★（旧方案【完全做不到】的能力）
  ├─ isEmpty()                     ← ⚠️ 与 getCell 返回 undefined 的"空白格"是两回事
  └─ setValue / setFormula         ← ❌ 见 §2.3【内核旁门，禁用】（要写值请用 range.setValue2）
```

**单格读值配方（★实测通过★）**：

```js
const v = await t.evaluate(() => {
  const sh = window.APP.workbook.getActiveSheet()
  const c = sh.getCell(2, 1)                       // 第3行第2列（0-based）= B3
  if (!c) return { ok: false, reason: '空白格返回 undefined' }
  const w = c.getValue()                           // 第一层：包装对象（JSON 形如 {"private":1}）
  const raw = (w && w.getValue) ? w.getValue() : String(w)   // ★第二层：裸值★
  return { ok: true, raw, formula: c.getFormula ? c.getFormula() : null }
})
```

**批量读配方（★实测通过：一次拿回 10×5 二维数组★）**：

```js
const v = await t.evaluate(async () => {
  const sh = window.APP.workbook.getActiveSheet()
  const rg = sh.createRange(sh.createRANGE(0, 9, 0, 4))   // 行0-9 × 列0-4 = A1:E10
  const r = await rg.getRangeContents()                    // Promise
  return r.result.Values                                   // [[…],[…]] 二维数组
})
```

**真实数据范围（★实测通过★）**：

```js
const r = await t.evaluate(() => {
  const sh = window.APP.workbook.getActiveSheet()
  const u = sh.getUsedRANGE()
  // ★ 必须摘标量字段再返回 —— 内核对象整个带出会报序列化错误 ★
  //   "Cannot serialize result: object reference chain is too long"（2026-09-28 实测踩过）
  return { rowFrom: u.rowFrom, rowTo: u.rowTo, colFrom: u.colFrom, colTo: u.colTo }
})
// → {rowFrom:0, rowTo:9, colFrom:0, colTo:4}
```

> ⚠️ 别用 `getBmp().getLastRow()` 判断数据范围 —— 它返回**理论边界 1048575**，与真实数据差了五个数量级。
> ⚠️ **同理，任何内核对象都不能直接作为 `evaluate` 返回值**（Range/Sheet/工作簿对象全部带不出去）—— 循环摘字段或标量再 return。

### 1.2 方案 B：名称框跳转 + ⌘C（兜底，任何时候可用）

```js
// ① 真实点击"名称框"（快照里的 textbox，值形如 "B9"）
await t.playwright('<名称框ref>', 'click')
// ② 输入范围并回车
await t.keyboard.press('Meta+a')
await t.keyboard.type('A1:Z200')
await t.keyboard.press('Enter')
await t.waitForTimeout(400)
// ③ 复制（macOS 必须 Meta+c）
await t.keyboard.press('Meta+c')
await t.waitForTimeout(300)
// ④ 读剪贴板（TSV）
await t.clipboard.read()
```

**要点**：
- WPS 会**把尾部空行列裁掉**，返回的是**有效数据边界**（如 45 字符）
- **两次不同范围（Z50 / Z200）读回逐字节一致 → 结果可复核**
- 名称框还能读**当前活动格坐标**（如 `B9`），公式栏可读**该格内容**

### 1.3 收益对照（为什么推荐 API 读）

| 能力 | 旧方案（名称框+⌘C）| API 方案 |
|---|---|---|
| **批量读** | ⚠️ 一次一片（须跳转 + 剪贴板）| ⭐⭐⭐ `range.getRangeContents()`（不碰剪贴板）|
| 单格读值 | ✅ 依赖剪贴板（**会覆盖用户剪贴板**）| ⭐ `getCell(r,c).getValue().getValue()` |
| **读公式** | ❌ 只能一格一格点公式栏看 | ⭐⭐ `getCell(r,c).getFormula()` |
| **真实数据范围** | ✅ 名称框 ⌘C 自动裁掉尾部空行 | ⭐⭐⭐ `sheet.getUsedRANGE()` |
| **写值** | 名称框跳转 + 键盘 type | ⭐⭐ `range.setValue2()`（**可撤销**）／键盘（保底）|

> ⚠️ **API 读取有延迟/缓存**：写入后**立刻读可能拿到旧值** → 会误判"写入失败"并重复写入（实测踩过）。
> **写完必须 `waitForTimeout(1000+)` 再读**。与 Excel「数据延迟加载」(`loadSheetData` / `loadDelayedData`) 同源。

---

## 二、写

### 2.1 首选：`range.setValue2(值)`（走正规命令层，可撤销 ✅）

```js
// ① 写（单格 = 1×1 区域；区域写值同理）
await t.evaluate(() => {
  const sh = window.APP.workbook.getActiveSheet()
  const rg = sh.createRange(sh.createRANGE(2, 2, 1, 1))   // B3（行2-2 × 列1-1；参数序 rowFrom,rowTo,colFrom,colTo）
  rg.setValue2(999)
})
// ② ★ 等数据同步（必须；立刻读会拿到旧值 → 误判"没写进去"而重复写入）
await t.waitForTimeout(1200)
// ③ 读回验证
const check = await t.evaluate(() => {
  const c = window.APP.workbook.getActiveSheet().getCell(2, 1)
  return c.getValue().getValue()                          // → 999
})
// ④ 撤销（实测成立）：window.APP.undo()
await t.evaluate(() => window.APP.undo())
```

**性质（实测）**：走 `execCmdWithConfirm` 正规命令层 → **可 `APP.undo()` 撤销、不污染编辑器状态**。
**类型保真**：数字传 `number`（落地 `ExecTokenDBL`）；传 `'121'` 字符串会存成文本。**要数字就别传字符串。**

> ⚠️⚠️ **批量写陷阱（2026-09-28 实测）**：
> - **`setValue2` 传二维数组整片写 = 静默失败** —— 调用不报错（`writeOk: true`），但回读全空；连"清空"用的空数组也一样可疑，**必须回读才算数**。
> - **同一 tick 连续快写多格也被合并丢弃** —— 36 格循环无间隔只落了第 1 格。
> - **可用配方：逐格 `createRANGE(r, r, c, c)` + `setValue2(单值)` + 每格间隔 ≥300ms**（在同一 evaluate 里 `await sleep(300)`），实测 36 格全落地、回读逐格一致。
> - 前置排除法：先写单格探针确认通道正常（单格写读没问题 → 问题在批量写法，不在编辑态/权限）。

**批量写正面配方（★实测通过：9×4=36 格全部落地、回读逐格一致★）**：

```js
// ★ 数据必须内联在 evaluate 回调体里 —— t.evaluate(fn, data) 传参可能静默丢失（d 变 undefined）
await t.evaluate(async () => {
  const data = [
    ['#', '决策点', '答案', '来源'],
    ['D1', '星标可逆性', '单向录入，不可撤销（…）', '用户答'],
    // …按需列全
  ]
  const sh = window.APP.workbook.getActiveSheet()
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))  // 回调在页面上下文执行，setTimeout 可用
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      const rg = sh.createRange(sh.createRANGE(r, r, c, c))
      rg.setValue2(data[r][c])
      await sleep(300)          // ★★ 每格 ≥300ms；无间隔 = 同 tick 合并丢弃 ★★
    }
  }
  return { written: data.length * data[0].length }
})
await t.waitForTimeout(1500)    // 读前等同步（5.12）
// ④ 整片回读逐格核对 —— writeOk:true 不算数，回读全空 = 没写进去
const check = await t.evaluate(() => {
  const sh = window.APP.workbook.getActiveSheet()
  const rg = sh.createRange(sh.createRANGE(0, 8, 0, 3))
  return rg.getRangeContents().then(r => r.result.Values)
})
```

### 2.2 保底：名称框跳转 + 键盘 type（任何时候可用 ✅）

```js
await t.playwright('<名称框ref>', 'click')     // 快照里的 textbox，值形如 "B9"
await t.keyboard.press('Meta+a')
await t.keyboard.type('B3')                    // 目标坐标
await t.keyboard.press('Enter')                // ★ 单元格进入选中态
await t.waitForTimeout(300)
await t.keyboard.type('KEYBOARD-WRITE-TEST')   // 真实键盘输入
await t.waitForTimeout(1000)                   // ★ 读前等 1s+
```

**原理**：Excel 能写，靠的不是"焦点进内核"，而是**名称框坐标跳转把键盘路由到了内核**。

> ⚠️ `document.activeElement` **永远停在 `IFRAME` 外壳**上 —— **这不是失败信号**（Excel 成功时也如此）。**别拿它当成败标尺。**

**实测（2026-09-27）**：`KEYBOARD-WRITE-TEST` → 写入 ✅ → API 读回 ✅ → 恢复原值 `1` ✅，全链路复核通过。

### 2.3 ⚠️⚠️ 红线：`cell.setValue()` 禁用（内核旁门）

**实测（2026-09-27）**：`setValue(999)` 数据**确实变了、也能读回** —— 但副作用严重：

| # | 副作用 | 现象 |
|---|---|---|
| ① | **污染编辑器状态** | ★ **用户手动编辑失效，必须刷新页面才能恢复** ★ |
| ② | 不进编辑栈 | `⌘Z` 无法撤销 |
| ③ | 后续 API 读取异常 | `getCell` 返回 `null` |
| ④ | 数据本身 | ✅ 未损坏（刷新后数据正确，污染只在内存态）|

**结论**：`cell.setValue()` 绕过编辑器状态同步，**禁用**。要写值 → **§2.1 `range.setValue2()`** 或 **§2.2 键盘**。

> **通用判据（跨全技能）**：**"看起来能写" ≠ "能安全地写"** —— 看它**走不走编辑器的事务/命令层**。
> 同族事故：Word 的 `pureTextStream.insertText`（见 `word.md`）。

### 2.4 清空区域（★无 API 级 clear，2026-09-28 实测配方★）

清空 = 把 used range 内每格写 `''`（复用 §2.1 批量写配方：逐格 + ≥300ms 间隔），**回读 `allEmpty` 才算清干净**。

```js
// ① 先定真实边界（内核对象摘字段，别整体 return）
const u = await t.evaluate(() => {
  const x = window.APP.workbook.getActiveSheet().getUsedRANGE()
  return { rowFrom: x.rowFrom, rowTo: x.rowTo, colFrom: x.colFrom, colTo: x.colTo }
})
// ② 逐格写空串（间隔 ≥300ms，与批量写同配方）
await t.evaluate(async () => {
  const sh = window.APP.workbook.getActiveSheet()
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (let r = 0; r <= 9; r++) for (let c = 0; c <= 4; c++) {
    sh.createRange(sh.createRANGE(r, r, c, c)).setValue2('')
    await sleep(300)
  }
  return { done: true }
})
// ③ 回读：整片每个格都是 ''/null 才算过
const ok = await t.evaluate(() => {
  const sh = window.APP.workbook.getActiveSheet()
  const rg = sh.createRange(sh.createRANGE(0, 9, 0, 4))
  return rg.getRangeContents().then(r =>
    r.result.Values.every(row => row.every(v => v === '' || v == null)))
})
```

> ⚠️ **两个坑**：
> ① **传二维空数组清空 = 静默失败**（与批量写同一坑，`writeOk` 照样 true）—— 必须回读。
> ② **清空后 `getUsedRANGE()` 仍返回旧边界**（rowTo 不缩小）—— 这不代表没清干净，**以内容回读为准**，不以 used range 变化为准。

---

## 三、Excel 专用自检清单

**读**：
- [ ] 优先 API 读（§1.1）：`getUsedRANGE` → `createRANGE` → `getRangeContents` / `getCell`
- [ ] API 不可用时退「名称框 + ⌘C」（§1.2），**记得 Meta+c**
- [ ] 写入后的读：先 `waitForTimeout(1000+)`

**写**：
- [ ] 首选 `range.setValue2()`；保底键盘（名称框跳转）
- [ ] ❌ 绝不用 `cell.setValue()`
- [ ] 写数字传 number，不传字符串
- [ ] 写入前后记录原值；出错用「原值回写」兜底（别指望 ⌘Z）

---

## 四、关联

- 返回主索引：`../SKILL.md`
- 通用陷阱：主文件 §5 —— **本类型相关：5.2（Ctrl+C）、5.4（activeElement）、5.12（读取延迟）、5.13（空白格 undefined）、5.14（理论边界）**
- 姐妹分册：`word.md` · `smart-doc.md` · `sheet-multi.md`