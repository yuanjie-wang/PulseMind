/** Options page (PLAN-browser-extension M0.5): manual serviceUrl/token
 *  overrides + live connection state from the service worker. */

const STATE_MESSAGE_TYPE = 'pulsemind/get-state'
const RECONNECT_MESSAGE_TYPE = 'pulsemind/reconnect'
const STORAGE_KEY = 'pulsemind'

const serviceUrlInput = document.getElementById('serviceUrl') as HTMLInputElement
const tokenInput = document.getElementById('token') as HTMLInputElement
const statusEl = document.getElementById('status') as HTMLDivElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement

interface StatePayload {
  connected: boolean
  state: string
  serviceUrl: string | null
  port: number | null
}

async function loadForm(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const cfg = (stored[STORAGE_KEY] ?? {}) as { serviceUrl?: string; token?: string }
  serviceUrlInput.value = cfg.serviceUrl ?? ''
  tokenInput.value = cfg.token ?? ''
}

function renderStatus(s: StatePayload): void {
  if (s.connected) {
    statusEl.className = 'ok'
    statusEl.textContent = `已连接：${s.serviceUrl ?? ''}`
  } else {
    statusEl.className = 'bad'
    statusEl.textContent = s.serviceUrl
      ? `未连接（${s.serviceUrl}，状态 ${s.state}）——请确认桌面端 PulseMind 正在运行`
      : '未发现桌面端服务——请确认 PulseMind 正在运行（端口 8765–8779）'
  }
}

async function sendMessage(type: string): Promise<StatePayload | null> {
  try {
    return (await chrome.runtime.sendMessage({ type })) as StatePayload
  } catch {
    return null
  }
}

async function refresh(): Promise<void> {
  const s = await sendMessage(STATE_MESSAGE_TYPE)
  if (s) renderStatus(s)
  else {
    statusEl.className = 'bad'
    statusEl.textContent = '无法联系后台——请重新加载扩展'
  }
}

saveBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      serviceUrl: serviceUrlInput.value.trim(),
      token: tokenInput.value.trim(),
    },
  })
  await sendMessage(RECONNECT_MESSAGE_TYPE)
  const saved = document.createElement('span')
  saved.className = 'saved'
  saved.textContent = '已保存 ✓'
  saveBtn.parentElement?.appendChild(saved)
  setTimeout(() => saved.remove(), 1500)
  setTimeout(refresh, 800)
})

refreshBtn.addEventListener('click', refresh)

void loadForm().then(refresh)
chrome.runtime.onMessage.addListener((msg: { type?: string; payload?: StatePayload }) => {
  if (msg?.type === 'pulsemind/get-state' && msg.payload) renderStatus(msg.payload)
})
