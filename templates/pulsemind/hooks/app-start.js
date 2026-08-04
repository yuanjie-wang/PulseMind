// app-start.js — Electron 主进程启动时执行
// 可在此设置环境变量或执行初始化逻辑

module.exports = async (ctx) => {
  console.log('[app-start] delay 2s for system readiness')
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // 设置环境变量示例，renderer 层可通过 window.electronAPI 读取
  process.env.DEVAGENT_API_KEY = '1'
}
