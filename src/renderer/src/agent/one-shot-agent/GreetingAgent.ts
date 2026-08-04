import { OneShotAgent } from './OneShotAgent'

function getTimeSlot(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 8) return '清晨'
  if (hour >= 8 && hour < 11) return '上午'
  if (hour >= 11 && hour < 13) return '中午'
  if (hour >= 13 && hour < 17) return '下午'
  if (hour >= 17 && hour < 19) return '傍晚'
  if (hour >= 19 && hour < 22) return '夜晚'
  return '深夜'
}

function getSeason(): string {
  const month = new Date().getMonth() + 1
  if (month >= 3 && month <= 5) return '春天'
  if (month >= 6 && month <= 8) return '夏天'
  if (month >= 9 && month <= 11) return '秋天'
  return '冬天'
}

export class GreetingAgent extends OneShotAgent<void, string | null> {
  readonly name = 'GreetingAgent'

  protected buildSystemPrompt(): string {
    return `执行规范（最高优先级，必须遵守）
1. 输出内容仅限最终问候语，禁止附带任何思考、推导、解释文字；
2. 问候要求：提供情绪价值，可随机风格：亲切、关怀、俏皮（积极15个字以内）
3. 句式：陈述句 / 感叹句；
4. 环境信息： ${getSeason()} ${getTimeSlot()}
5. 禁令：无消极抱怨。
直接输出结果`
  }

  protected buildUserMessages(): { role: string; content: string }[] {
    return [{ role: 'user', content: `当前是${getSeason()}${getTimeSlot()}` }]
  }

  protected parseResponse(raw: string): string | null {
    const cleaned = raw.replace(/["""「」『』【】《》'']/g, '').trim()
    return cleaned.length >= 4 ? cleaned : null
  }

  protected getDefaultOutput(): string | null {
    return null
  }
}
