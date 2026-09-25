// app-start.js — Electron 主进程启动时执行
// 可在此设置环境变量或执行初始化逻辑。
//
// ⚠ 本钩子门控主窗口创建（登录门）：钩子跑多久，应用就等多久 —— splash
//   会一直顶屏（钩子用 ctx.browser.open 打开内置浏览器的瞬间，splash 自动
//   关闭，两个窗口不会同屏）。轮询/等待必须自带超时与放弃分支，否则应用
//   永远停在启动页。
//
// 下面的登录流程是示例骨架（保持注释态）：直接启用会因 checkSession 未定义
// 而报错，且打开的登录窗不会被关闭。按你的服务端校验接口改写、补上
// checkSession 实现、确认无误后，再逐段取消注释。

module.exports = async (ctx) => {
  // ── 示例：内置浏览器登录流程（按你的服务端校验接口改写） ──
  //
  // async function checkSession() {
  //   try {
  //     const res = await fetch('https://api.example.com/session/check', { headers: { … } })
  //     return res.ok
  //   } catch {
  //     return false
  //   }
  // }
  //
  // // 1. 本地校验 session，有效 → 直接放行（跳到 return）
  // const valid = await checkSession()
  // if (!valid) {
  //   // 2. 无效 → 用内置浏览器打开登录页（应用自己的 Chromium，共享持久会话；
  //   //    打开的瞬间启动 splash 自动关闭）
  //   const win = await ctx.browser.open('https://example.com/login', { title: '登录' })
  //   // 3. 本地轮询服务端登录结果 —— 必须有超时（这里 5 分钟）与放弃分支
  //   const deadline = Date.now() + 5 * 60_000
  //   while (Date.now() < deadline) {
  //     if (await checkSession()) break
  //     await new Promise((resolve) => setTimeout(resolve, 2000))
  //   }
  //   // 4. 登录成功（或超时放弃）→ 关窗，应用继续启动
  //   await win.close()
  // }

  // 返回的 env 进入 hookEnv（终端/MCP 子进程与 ${ENV} 占位符可读）；
  // 也可以随时直接写 process.env。
  // renderer 层可通过 window.electronAPI 读取。
  // process.env.DEVAGENT_API_KEY = '…'
  return { env: {} }
}
