// 会话类日常任务的提示词框尺寸契约（user 2026-11-23：「滚动条滚动不顺滑」
// 「输入框可以向下撑满」，二次裁定「要撑到底」）。
//
// 三个毛病同源，都在「框有多大」这一件事上：
//   · 固定 rows={8} 在向导的页面滚动容器里又造了一层内嵌滚动条（滚轮先喂内层、
//     到底才链到页面 = 「滚两下才动」）；
//   · antd 的 textarea.ant-input 带缺省 resize:vertical，右下角手柄能一路把框
//     拖满整页；
//   · 框的高度不跟卡片走——下面空一大片，用户要的是撑到底。
//
// 现行契约 = 链条上的每个盒子都写死职责：TaskWizardPage 内容步 height:'100%'
// → 提示词字段 div flex:1 → textarea 用 styles.textarea 吃到 flex:1（antd 的
// TextArea style 只透传 resize，flex 走 style 落不到元素上），内容超出就由
// textarea 自己滚动。autoSize 已退场：它的内联行高会与 flex 拉伸打架，而且终点
// 是内容高度、撑不到底。
//
// vitest 这里是 node-env（无 React mount），所以只钉源码契约；行为证据（真框的
// 下缘到卡片内底的距离/窗口变高跟长/滚轮归属）在
// scripts/probe-workflow-wizard.mjs §16。

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const form = readFileSync(join(ROOT, 'src/renderer/src/components/routine/RoutineForm.tsx'), 'utf-8')
const wizard = readFileSync(join(ROOT, 'src/renderer/src/components/routine/TaskWizardPage.tsx'), 'utf-8')

describe('提示词框：撑满卡片剩余高度、内部滚动、不能拖拽', () => {
  it('字段 div 是纵向 flex 且吃掉剩余高度', () => {
    expect(form).toContain(
      'data-routine-field="prompt" style={{ flex: 1, minHeight: 0, display: \'flex\', flexDirection: \'column\' }}',
    )
  })

  it('textarea 的 flex 走 styles.textarea（style 只透传 resize）', () => {
    expect(form).toContain(
      "styles={{ textarea: { flex: 1, minHeight: 160, overscrollBehavior: 'contain' } }}",
    )
    // autoSize 与 flex 拉伸互相打架，且撑不到底——回潮即「盒子随内容停在中途」。
    expect(form).not.toMatch(/<Input\.TextArea[\s\S]{0,600}?autoSize=/)
    // 固定 rows 是内嵌滚动条的来源——回潮即两段式滚动重现。
    expect(form).not.toMatch(/<Input\.TextArea[\s\S]{0,600}?\n\s+rows=\{8\}/)
  })

  it('resize: none 拧掉 antd 缺省的垂直手柄', () => {
    expect(form).toContain("resize: 'none'")
  })

  it('向导内容步把高度传给提示词字段（height:100% 是链条第一环）', () => {
    expect(wizard).toContain("gap: 14, height: '100%'")
  })

  it('探针/wiring 的锚点原样保留', () => {
    expect(form).toContain('data-routine-field="prompt"')
    expect(form).toContain('data-routine-field="prompt-head"')
  })
})

// 滚动条这一半的实测结论（2026-11-23，user 二次澄清「滚动条不跟随滚动，等内容
// 停止滚动时才更新位置」）：真 App 里用合成器手势滚动（CDP
// Input.synthesizeScrollGesture，等价于触控板）逐帧解像素——自定义
// ::-webkit-scrollbar 的拇指全程钉在 y 197–373（34 帧只有 4 个位置签名），手势
// 结束才一跳落到 302–478；同一个框换成原生条，34 帧 25–33 个位置、逐帧跟随后
// 淡出。裸 div 挂全局 6px 自定义条同样冻结 ⇒ 病根是「自定义条由主线程绘制」，
// 不是这个输入框。现行契约 = 全局只用标准属性（scrollbar-width/scrollbar-color，
// 合成器绘制），全仓不得再出现 ::-webkit-scrollbar（唯一例外 = display:none 的
// 无条容器，没有拇指可跟）。
// vitest 无滚动条渲染，这里钉源码契约；逐帧行为证据来自一次性合成器手势
// harness（CDP Input.synthesizeScrollGesture + screencast 逐帧解像素，事后已删，
// 数字与结论已入 AGENTS.md 与 index.html 注释）。
describe('滚动条：原生绘制（自定义条会让拇指在合成器滚动中冻结）', () => {
  const html = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf-8')
  const layout = readFileSync(join(ROOT, 'src/renderer/src/components/layout/AppLayout.tsx'), 'utf-8')

  it('全局声明标准属性（thin + 灰色拇指/透明轨道，落在 * 上）', () => {
    // scrollbar-width 不继承（实测：只写在 html 上时 textarea computed=auto，
    // Win/Linux 会退回宽条），所以这对属性必须打在 * 上。
    expect(html).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/)
    expect(html).toMatch(/\*\s*\{[^}]*scrollbar-color:\s*rgba\(128,\s*128,\s*128,[^)]*\)\s*transparent/)
  })

  it('渲染层不再有任何自定义滚动条（display:none 的隐藏条除外）', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(html|tsx|ts|css)$/.test(e.name)) files.push(p)
      }
    }
    walk(join(ROOT, 'src/renderer'))
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      // 注释里的提及不算（tombstone 注释要能写"别加这个"）。
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of code.matchAll(/::-webkit-scrollbar(?![-\w])[^{]*\{([^}]*)\}/g)) {
        if (!/display:\s*none/.test(m[1])) offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0].slice(0, 60)}`)
      }
      // 只写 ::-webkit-scrollbar-thumb 之类而不写基类同样进自定义模式。
      if (/::-webkit-scrollbar-(thumb|track|button|corner)/.test(code)) {
        offenders.push(`${f.slice(ROOT.length + 1)}: ::-webkit-scrollbar-* 子伪元素`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('提示词框不再挂自定义条类（撑满与滚轮归属不变）', () => {
    expect(form).not.toContain('pm-prompt-scroll')
    expect(form).not.toContain('rootClassName=')
    expect(form).toContain("overscrollBehavior: 'contain'")
  })

  it('设置页只改颜色、不改绘制方式（主题变量仍是唯一钩子）', () => {
    expect(layout).toContain('.settings-scroll {')
    expect(layout).toMatch(/\.settings-scroll\s*\{[^}]*scrollbar-color:\s*var\(--pm-scrollbar\)\s+transparent/)
    expect(layout).not.toContain('.settings-scroll::-webkit-scrollbar')
  })
})