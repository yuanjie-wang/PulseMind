import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmAdapter } from '../llm/adapter'
import { GreetingAgent } from '../agent/one-shot-agent/GreetingAgent'
import { pickGreetingEnv, pickGreetingStyle } from '../agent/one-shot-agent/greeting-styles'

export function useGreeting(
  adapter: LlmAdapter,
  apiKey: string | null,
  baseURL: string,
  model: string,
  modelMaxTokens?: number,
): { greeting: string | null; regenerateGreeting: () => void } {
  const [greeting, setGreeting] = useState<string | null>(null)
  const agentRef = useRef(new GreetingAgent())
  const optsRef = useRef({ adapter, apiKey, baseURL, model, modelMaxTokens })
  // 上一次的风格 id——pickGreetingStyle 据此排除，欢迎语不连续两拍同风格。
  const lastStyleRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    optsRef.current = { adapter, apiKey, baseURL, model, modelMaxTokens }
  })

  useEffect(() => {
    if (!apiKey || !baseURL || !model) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const style = pickGreetingStyle(lastStyleRef.current)
      lastStyleRef.current = style.id
      const text = await agentRef.current.execute(
        { style, env: pickGreetingEnv() },
        {
          llmConfig: { apiKey, baseURL, model, adapter, modelMaxTokens },
          maxOutputTokens: 4096,
        },
      )
      if (!cancelled && text) setGreeting(text)
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [apiKey, baseURL, model, adapter, modelMaxTokens])

  const regenerateGreeting = useCallback(() => {
    const { apiKey, baseURL, model, adapter, modelMaxTokens } = optsRef.current
    if (!apiKey || !baseURL || !model) return
    setGreeting(null)
    const style = pickGreetingStyle(lastStyleRef.current)
    lastStyleRef.current = style.id
    agentRef.current
      .execute(
        { style, env: pickGreetingEnv() },
        {
          llmConfig: { apiKey, baseURL, model, adapter, modelMaxTokens },
          maxOutputTokens: 4096,
        },
      )
      .then((text) => {
        if (text) setGreeting(text)
      })
  }, [])

  return { greeting, regenerateGreeting }
}
