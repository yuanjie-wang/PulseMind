/**
 * Agent-change review diff（2026-11-01 pivot）：agent write/edit 落盘后，
 * 预览 VIEW 态以 UnifiedMergeView 只读高亮「它改了什么」（改动前文本 vs
 * 新盘文，无接受/拒绝控件）。用户自己的输入不产生 diff（用户裁定）。
 *
 * 三层，与仓库测试纪律一致：
 *   - store 语义走真 store：capture 消费、base 生命周期（保存清、关页签清）、
 *     diffVisible 缺省 = 自动显示且新变动重置显式隐藏；
 *   - 重建纯逻辑：old_str/new_str 反推改动前文本（首处 / multi 全部）；
 *   - 接线扫描钉住渲染面（view 态专用、无控件、两段式 reconfigure、编辑态
 *     不挂）+ sync 捕获次序（先 spec 后 bumpReload）。
 *
 * 浏览器内行为（标记 DOM、关闭态、保存清空）归 scripts/probe-preview-edit.mjs。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconstructPreChangeText } from '../src/shared/diff/reconstruct-baseline'

// 同一条 store 的一次导入（旧文件连写两条 await import——tests 不在任何
// tsconfig include 里，类型永不检查，重复是纯噪音）。
const { DRAFT_CONVERSATION_KEY, usePreviewPaneStore, openInPreviewPane } = await import('../src/renderer/src/stores/previewPaneStore')

const ROOT = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('previewPaneStore：agentDiff 三张图', () => {
  it('noteLoadedText 记录最近盘文（capture 的基线来源），关页签一起遗忘', () => {
    usePreviewPaneStore.getState().setWorkspaceDir('/ws')
    openInPreviewPane('src/cap.ts')
    const p = usePreviewPaneStore.getState().activeByConversation[DRAFT_CONVERSATION_KEY]
    usePreviewPaneStore.getState().noteLoadedText(p!, '旧文本\n')
    expect(usePreviewPaneStore.getState().loadedTexts[p!]).toBe('旧文本\n')
    usePreviewPaneStore.getState().closeTab(null, p!)
    expect(usePreviewPaneStore.getState().loadedTexts[p!]).toBeUndefined()
  })

  it('setAgentDiffCapture 落 reconstruct spec，clear 单独摘除；closeTab 同批清', () => {
    const st0 = usePreviewPaneStore.getState()
    st0.setAgentDiffCapture('/w/b.ts', { mode: 'reconstruct', oldStr: '旧', newStr: '新', multiAll: false })
    expect(usePreviewPaneStore.getState().agentDiffCaptures['/w/b.ts']).toEqual({ mode: 'reconstruct', oldStr: '旧', newStr: '新', multiAll: false })
    usePreviewPaneStore.getState().clearAgentDiffCapture('/w/b.ts')
    expect(usePreviewPaneStore.getState().agentDiffCaptures['/w/b.ts']).toBeUndefined()
    usePreviewPaneStore.getState().setAgentDiffCapture('/w/b.ts', { mode: 'reconstruct', oldStr: '旧', newStr: '新', multiAll: false })
    usePreviewPaneStore.getState().closeTab(null, '/w/b.ts')
    expect(usePreviewPaneStore.getState().agentDiffCaptures['/w/b.ts']).toBeUndefined()
  })

  it('agentDiffBases：set/clear 幂等（clear 不存在的键返回原引用）', () => {
    const st = usePreviewPaneStore.getState()
    st.setAgentDiffBase('/w/r.ts', '改动前')
    expect(usePreviewPaneStore.getState().agentDiffBases['/w/r.ts']).toBe('改动前')
    const before = usePreviewPaneStore.getState().agentDiffBases
    usePreviewPaneStore.getState().clearAgentDiffBase('/w/absent.ts')
    expect(usePreviewPaneStore.getState().agentDiffBases).toBe(before)
    usePreviewPaneStore.getState().clearAgentDiffBase('/w/r.ts')
    expect(usePreviewPaneStore.getState().agentDiffBases['/w/r.ts']).toBeUndefined()
  })

  it('diffVisible 缺省 = 自动显示；显式 false 在新 capture 落地时由消费方重置', () => {
    expect(usePreviewPaneStore.getState().diffVisible['/w/x.ts']).toBeUndefined()
    usePreviewPaneStore.getState().setDiffVisible('/w/x.ts', false)
    expect(usePreviewPaneStore.getState().diffVisible['/w/x.ts']).toBe(false)
  })

  it('forgetConversation 按会话批量遗忘 loadedTexts/captures/bases', () => {
    usePreviewPaneStore.getState().setWorkspaceDir('/ws')
    openInPreviewPane('src/conv-diff.ts')
    const p = usePreviewPaneStore.getState().activeByConversation[DRAFT_CONVERSATION_KEY]!
    const st = usePreviewPaneStore.getState()
    st.noteLoadedText(p, 'x')
    st.setAgentDiffCapture(p, { mode: 'reconstruct', oldStr: '旧', newStr: '新', multiAll: false })
    st.setAgentDiffBase(p, 'y')
    usePreviewPaneStore.getState().forgetConversation(DRAFT_CONVERSATION_KEY)
    const after = usePreviewPaneStore.getState()
    expect(after.loadedTexts[p]).toBeUndefined()
    expect(after.agentDiffCaptures[p]).toBeUndefined()
    expect(after.agentDiffBases[p]).toBeUndefined()
  })
})

describe('重建纯逻辑：old_str/new_str 反推改动前文本', () => {
  // review_20261103 中5：这里过去是手抄实现，「测试全绿而生产代码有两个真错」
  // 正是它造成的——现在生产（PreviewContent resolve）与测试同源导入
  // src/shared/diff/reconstruct-baseline.ts；sync 侧的 spec 形状由接线扫描钉住。
  const rebuild = (after: string, oldStr: string, newStr: string, multiAll: boolean): string =>
    reconstructPreChangeText(after, { oldStr, newStr, multiAll })

  it('首处替换：只回退第一次出现', () => {
    expect(rebuild('A新B新C', '旧', '新', false)).toBe('A旧B新C')
  })
  it('multi 全部替换：回退每一次出现', () => {
    expect(rebuild('A新B新C', '旧', '新', true)).toBe('A旧B旧C')
  })
  it('new_str 未命中（盘文已再变）：回落原样 = 空 diff，诚实不猜', () => {
    expect(rebuild('原样', '旧', '新', false)).toBe('原样')
  })

  // ── review_20261103 中3：替换串里的 $ 是数据不是模式 ── String.replace 对
  // 替换串解释 $&/$`/$'/$$——bash 的 $$、ANSI-C $'…'、Makefile 的 $$ 必中；
  // split/join（multiAll 臂）从不解释，两臂不一致即证明是疏漏。修法 = 函数替换器。
  // 夹具方向：after（盘文）含的是 new_str（agent 改后的文本），重建回 old_str。
  it('替换串里的 $ 按字面处理（bash $$ / ANSI-C $… 不再被解释成模式）', () => {
    // 旧实现：'a$$2b'.replace('$$2', '$$1') → 'a$1b'（$$ 折叠成一个 $）
    expect(rebuild('a$$2b', '$$1', '$$2', false)).toBe('a$$1b')
    // 旧实现：替换串 $' 展开成「匹配之后的尾巴」= '' → 'echo旧'
    expect(rebuild("echo $'新'", "$'旧'", "$'新'", false)).toBe("echo $'旧'")
    // 旧实现：'kill -0 $PID'.replace('$PID', '$$') → 'kill -0 $'（$$ → $）
    expect(rebuild('kill -0 $PID', '$$', '$PID', false)).toBe('kill -0 $$')
    // multiAll 臂行为不变（split/join 本就不解释模式）
    expect(rebuild('x!y!z', '$$', '!', true)).toBe('x$$y$$z')
  })

  // ── review_20261103 中3：纯删除 edit（newStr=''）── 旧守卫只挡空 oldStr，
  // `after.replace('', oldStr)` 把 old_str 插到开头，multiAll 臂更是逐字符间插
  // ——整文档级假 diff。
  it('空 new_str（纯删除 edit）：诚实空 diff，不做文档级假 diff', () => {
    expect(rebuild('正文内容', '正文内容', '', false)).toBe('正文内容')
    expect(rebuild('正文内容', '文', '', true)).toBe('正文内容')
  })
  it('空 old_str 同样直接原样返回（防御：sync 捕获守卫已拒）', () => {
    expect(rebuild('原样', '', '新', false)).toBe('原样')
  })

  // ── review_20261103 中4：CRLF 容忍 ── 主侧 editFile 明确做了归一匹配→写回
  // 还原 CRLF；重建臂拿模型发出的 LF 形态去匹配 CRLF 原文，多行 needle 永不
  // 命中，Windows 作者的文件上这条审阅路径系统性空转。
  it('CRLF 文件：LF 形态的 old_str/new_str 照常命中，重建结果还原 CRLF', () => {
    const after = 'function a() {\r\n  return 2\r\n}\r\n'
    expect(rebuild(after, 'return 1', 'return 2', false)).toBe('function a() {\r\n  return 1\r\n}\r\n')
    // 多行 needle：模型发出的 LF 换行在 CRLF 盘文上照常命中
    const multiAfter = 'fn a() {\r\n  return 2\r\n}\r\nfn b() {\r\n  x\r\n}\r\n'
    expect(rebuild(multiAfter, 'return 1\r\n}\r\nfn b', 'return 2\r\n}\r\nfn b', true)).toBe(
      'fn a() {\r\n  return 1\r\n}\r\nfn b() {\r\n  x\r\n}\r\n'
    )
  })
  it('LF 文件行为不变（单行无换行的 edit 天然命中，不受归一影响）', () => {
    expect(rebuild('a\nB\nc', 'b', 'B', false)).toBe('a\nb\nc')
  })
})

describe('wiring 扫描：审阅 diff 四环节', () => {
  it('CodeMirrorEditor：view 态专用（!readOnly 才拒挂）+ mergeControls:false 无控件', () => {
    const cm = src('src/renderer/src/components/preview/CodeMirrorEditor.tsx')
    expect(cm).toContain('unifiedMergeView({ original, mergeControls: false })')
    // 守卫方向反转：编辑态（!readOnly）与无基线都落空 reconfigure
    const fn = cm.slice(cm.indexOf('// Agent-change review diff'), cm.indexOf('// Reveal: scroll the target line'))
    expect(fn).toContain('if (viewDiffBase == null || !readOnly)')
    expect(fn).toContain('mergeComp.reconfigure([])')
    expect(fn).toContain('mergeComp.reconfigure(buildMergeExt(viewDiffBase))')
    // 无控件（用户裁定「不用接受和拒绝按钮」）。 phrases/locale 依赖曾是
    // 该裁定的推论（无按钮→无文案），2026-11-02 搜索面板 i18n 落地后
    // 失效——CodeMirrorEditor 现从 useTranslation 取 cmSearch 词表；裁定
    // 本身（merge 视图零控件）由上面的 mergeControls:false + 下行钉住。
    expect(cm).not.toContain('mergeAccept')
  })

  it('PreviewContent：view 态接线（编辑态永不挂）+ capture 解析消费 spec', () => {
    const content = src('src/renderer/src/components/preview/PreviewContent.tsx')
    expect(content).toContain('const viewDiffBase = !editMode && diffOn && agentBase != null')
    expect(content).toContain('viewDiffBase={viewDiffBase}')
    // 消费端：resolve 后清 spec、置 base、重置显式隐藏（新变动自动现身）
    expect(content).toContain('st.setAgentDiffBase(path, before)')
    expect(content).toContain('st.clearAgentDiffCapture(path)')
    expect(content).toContain('st.setDiffVisible(path, true)')
    // loadedTexts 上报（capture 的基线来源）
    expect(content).toContain('noteLoadedText(path, capped.text)')
    // 编辑态不传 diff（props 面上只有 view 一处）
    expect(content.split('viewDiffBase={viewDiffBase}').length - 1).toBe(1)
  })

  it('sync：事件拍点定型基线（loadedTexts 快照）+ reconstruct 兜底，先于 reload', () => {
    const sync = src('src/renderer/src/hooks/usePreviewPaneSync.ts')
    const baseIdx = sync.indexOf('store.setAgentDiffBase(abs, before)')
    const bumpIdx = sync.indexOf('store.bumpReload(abs)')
    expect(baseIdx).toBeGreaterThan(0)
    expect(bumpIdx).toBeGreaterThan(baseIdx)
    expect(sync).toContain('} else if (meta?.reconstruct) {')
    expect(sync).toContain('store.setAgentDiffCapture(abs, meta.reconstruct)')
    expect(sync).toContain("mode: 'reconstruct' as const, oldStr, newStr, multiAll: input?.multi === true")
    // 发射即弃（review_20261104 中5）：原始 old_str/new_str 只活到发射这一拍，
    // known 不再持有第二副本（文件头纪律；store 侧副本 resolve 时自清）。
    const deleteIdx = sync.indexOf('known.delete(ev.toolUseId)')
    expect(deleteIdx).toBeGreaterThan(sync.indexOf('store.setAgentDiffCapture(abs, meta.reconstruct)'))
    expect(deleteIdx).toBeLessThan(sync.indexOf('store.bumpReload(abs)'))
  })

  it('保存清基线 + 菜单门在有 base 时才可用', () => {
    const pane = src('src/renderer/src/components/preview/PreviewPane.tsx')
    expect(pane).toContain('store.clearAgentDiffBase(path)')
    expect(pane).toContain('store.clearAgentDiffCapture(path)')
    const actions = src('src/renderer/src/components/workbench/preview-file-actions.tsx')
    expect(actions).toContain('const diffDisabled = !activePath || !agentDiffBases[activePath]')
    expect(actions).toContain("diffOn ? t('previewPane.diffHide') : t('previewPane.diffShow')")
  })

  it('locale：开关两键在，按钮文案键已删', () => {
    const en = src('src/renderer/src/i18n/locales/en.ts')
    const zh = src('src/renderer/src/i18n/locales/zh.ts')
    for (const key of ['diffShow', 'diffHide']) {
      expect(en).toContain(`${key}: '`)
      expect(zh).toContain(`${key}: '`)
    }
    expect(en).not.toContain('mergeAccept')
    expect(zh).not.toContain('mergeReject')
  })
})
