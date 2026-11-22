// ── 设置保存 → 活着会话的 option bag（2026-11-22）──
//
// 病：改「最大上下文」/「输出上限」/「API Key」是紧存盘，已打开的会话仍用它
// 建会话那一刻的 option bag，直到应用重启（引擎实例活在 session-manager 的
// sessions 表里，只有 dispose 才走）。实测 conv_20261122211023：21:13 把模型
// 改成 contextLength 50000 落盘，21:14–21:16 的六个请求状态块仍写
// `~26% used (~39K / 150K tokens)`，`main.log` 的每轮预算仍是 b=117232
// （= 150000 − 32768），一次压缩都没触发——用户以为在验 50K，其实还在 150K 上跑。
//
// 为什么必须先判「哪些字段算变了」，而不是每次保存都无脑刷一遍：
// updateOptions 是**整包替换**（AgentEngine.updateOptions），每次刷新都会重建
// adapter、重跑 contextWindowReaim 的钳制、并把 toolExecutor 的 options 换掉。
// 保存主题、保留期、通知 webhook 这类跟引擎毫无关系的改动不该动所有活会话。
// 所以判据取「这次保存是否改了 bag 的任一输入」，不是「这次保存是否发生过」。

import type { AppSettings } from '../../shared/types/settings'

/**
 * 进入引擎 option bag 的设置面 —— 与 `session-manager.refreshOptions` 拷进
 * `updateOptions` 的那些字段一一对应（模型连接五件套 + 预算两件 + 缓存/守卫
 * 开关 + 系统提示里的人格与人称 + 工作区兜底）。审美/保留期/通知/代理等不在
 * 此列，它们各有各的消费点，不经过引擎的 option bag。
 *
 * 逐字段列而不是整份 `JSON.stringify(settings)`：后者会让「改个主题」也算
 * 变了，判据就退回成「每次保存都刷」。
 */
export function optionBagSignature(s: AppSettings): string {
  return JSON.stringify({
    myName: s.myName ?? '',
    soul: s.soul ?? '',
    yourName: s.yourName ?? '',
    locale: s.locale ?? 'zh',
    // refreshOptions 用它兜底会话没绑工作区的情况；工作区换了，下一轮的系统
    // 提示与沙箱根都该跟着换。
    workspaceDir: s.workspaceDir ?? '',
    profiles: (s.profiles ?? []).map((p) => ({
      id: p.id,
      // provider 决定 createLlmAdapter 用哪个适配器，改名以外它也变（供应商
      // 换了协议）就必须换袋，否则旧 adapter 还在发旧格式的请求。
      provider: p.provider ?? '',
      model: p.model ?? '',
      baseURL: p.baseURL ?? '',
      apiKey: p.apiKey ?? '',
      maxTokens: p.maxTokens ?? null,
      contextLength: p.contextLength ?? null,
      earlyStopGuard: p.earlyStopGuard === true,
      promptCache: p.promptCache ?? null,
    })),
  })
}

/**
 * 把一次设置保存推给活着的会话：**只有 bag 的输入真变了**才调 `refresh`。
 *
 * 两份都必须喂**存储层视图**（`settingsStore.get()`），不要喂调用方的保存
 * 载荷：写入只认 `providers`，派生的 `profiles` 是 `set()` 重算出来的，渲染端
 * 快照里那份可能是旧的；拿旧快照当「新值」，真改动会被判成没改。
 *
 * `previous` 为 null = 没有可比基线（模板包导入：设置已由导入步骤写进去，
 * 这里拿不到旧值），按「一定变了」处理 —— 那条路确实可能整批换掉模型。
 *
 * 返回是否真的刷新了：调用方与测试要能区分「跳过」与「刷过」，一个恒真的
 * 返回值会让「没变就不刷」这条纪律永远测不出来。
 */
export async function refreshOptionBags(
  previous: AppSettings | null,
  next: AppSettings,
  // `unknown` 而不是 `void`：真实调用方是会回报「刷了几个会话」的整表扫描，
  // 这里的判据不关心返回值。
  refresh: () => Promise<unknown>,
): Promise<boolean> {
  if (previous && optionBagSignature(previous) === optionBagSignature(next)) return false
  await refresh()
  return true
}
