import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmAdapter } from '../llm/adapter'
import { GreetingAgent } from '../agent/one-shot-agent/GreetingAgent'

export function useGreeting(
  adapter: LlmAdapter,
  apiKey: string | null,
  baseURL: string,
  model: string,
  modelMaxTokens?: number
): { greeting: string | null; regenerateGreeting: () => void } {
  const [greeting, setGreeting] = useState<string | null>(null)
  const agentRef = useRef(new GreetingAgent())
  const optsRef = useRef({ adapter, apiKey, baseURL, model, modelMaxTokens })

  useEffect(() => {
    optsRef.current = { adapter, apiKey, baseURL, model, modelMaxTokens }
  })

  useEffect(() => {
    if (!apiKey || !baseURL || !model) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const text = await agentRef.current.execute(undefined, {
        llmConfig: { apiKey, baseURL, model, adapter, modelMaxTokens },
        maxOutputTokens: 4096
      })
      if (!cancelled && text) setGreeting(text)
    }, 100)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [apiKey, baseURL, model, adapter, modelMaxTokens])

  const regenerateGreeting = useCallback(() => {
    const { apiKey, baseURL, model, adapter, modelMaxTokens } = optsRef.current
    if (!apiKey || !baseURL || !model) return
    setGreeting(null)
    agentRef.current.execute(undefined, {
      llmConfig: { apiKey, baseURL, model, adapter, modelMaxTokens },
      maxOutputTokens: 4096
    }).then((text) => {
      if (text) setGreeting(text)
    })
  }, [])

  return { greeting, regenerateGreeting }
}
