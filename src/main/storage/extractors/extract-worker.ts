import { extractFile } from './index'

process.on('message', async (msg: { type: string; filePath: string }) => {
  if (msg.type !== 'extract') return
  try {
    const result = await extractFile(msg.filePath)
    if (process.send) process.send({ type: 'result', success: true, title: result.title, content: result.content })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (process.send) process.send({ type: 'result', success: false, error: message })
  }
})
