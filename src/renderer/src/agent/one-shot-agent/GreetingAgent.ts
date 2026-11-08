import { OneShotAgent } from './OneShotAgent'
import type { GreetingEnv, GreetingStyle } from './greeting-styles'

/** 一次问候请求：风格由代码预选，环境要素（时段/季节）各自 50% 上送
 *  （pickGreetingEnv 判定，null = 这一拍不带——避免每次都锚在环境词上）。 */
export interface GreetingRequest {
  style: GreetingStyle
  env: GreetingEnv
}

export class GreetingAgent extends OneShotAgent<GreetingRequest, string | null> {
  readonly name = 'GreetingAgent'

  protected buildSystemPrompt({ style, env }: GreetingRequest): string {
    const envText = [env.season, env.slot].filter(Boolean).join(' ')
    // 环境行只在有要素时出现——两要素都缺席时让模型自由发挥，行号顺延。
    const lines = [
      '执行规范（最高优先级，必须遵守）',
      '1. 输出内容仅限最终问候语，禁止附带任何思考、推导、解释文字；',
      `2. 问候要求：提供情绪价值，风格为「${style.name}：${style.instruction}」（积极，15个字以内）`,
      '3. 句式：陈述句 / 感叹句；',
      ...(envText ? [`4. 环境信息： ${envText}`] : []),
      `${envText ? '5' : '4'}. 禁令：无消极抱怨。`,
      '直接输出结果',
    ]
    return lines.join('\n')
  }

  protected buildUserMessages({ env }: GreetingRequest): { role: string; content: string }[] {
    const envText = [env.season, env.slot].filter(Boolean).join('')
    return [{ role: 'user', content: envText ? `当前是${envText}` : '请输出问候语' }]
  }

  protected parseResponse(raw: string): string | null {
    const cleaned = raw.replace(/["""「」『』【】《》'']/g, '').trim()
    return cleaned.length >= 4 ? cleaned : null
  }

  protected getDefaultOutput(): string | null {
    return null
  }
}
