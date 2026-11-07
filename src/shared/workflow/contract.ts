// PLAN-workflow-engine：PIPELINE_RESULT 契约行解析（shared 纯逻辑）。
//
// 契约行形态（末条 assistant 消息全文扫描，镜像 parseSopVerdict 但不要求
// 严格末行）：`PIPELINE_RESULT: {"verdict":"…","summary":"…","artifacts":["…"]}`
//
// 评审缺口③的放宽：coding 会话正文长、可能被截断，严格末行会产生大量早停
// 假阳性——全文扫描取**最后一个合法契约行**。verdict 是否在该节点 verdicts
// 声明内的判定不在这里（引擎结算时比表）；这里只负责「找到并解析出最后一个
// 合法的行」。

export interface PipelineContract {
  verdict: string
  summary: string
  artifacts: string[]
}

/** 契约行前缀（模板教学段与 formatPipelineResult 的同一真源）。 */
export const PREFIX = 'PIPELINE_RESULT:'

/** artifacts 路径合法性（评审缺口②的校验面）：工作区相对路径，禁绝对路径、
 *  禁 `..`、禁空。保存/启动/助手应用三处的 validate 门也会调它（plan 校验
 *  清单的 artifacts 路径合法性）。 */
export function artifactPathError(path: string): string | null {
  if (!path || !path.trim()) return 'artifacts 路径为空'
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return `artifacts 路径必须是工作区相对路径：「${path}」`
  if (path.includes('..')) return `artifacts 路径不得包含「..」：「${path}」`
  if (path.includes('\\')) return `artifacts 路径分隔符请用 /：「${path}」`
  return null
}

/** 从一行里解析契约对象；不合法返回 null（全文扫描跳过它继续找前面的行）。 */
function parseContractLine(line: string): PipelineContract | null {
  const at = line.indexOf(PREFIX)
  if (at === -1) return null
  const json = line.slice(at + PREFIX.length).trim()
  if (!json.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.verdict !== 'string' || !obj.verdict.trim()) return null
  const artifacts = Array.isArray(obj.artifacts) ? obj.artifacts.filter((a): a is string => typeof a === 'string') : []
  return {
    verdict: obj.verdict.trim(),
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    artifacts,
  }
}

/** 全文扫描取最后一个合法契约行；没有 → null（早停激发臂的判据）。 */
export function parsePipelineResult(text: string): PipelineContract | null {
  let found: PipelineContract | null = null
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseContractLine(line)
    if (parsed) found = parsed
  }
  return found
}

/** 渲染契约行（模板 prompt 的教学段与助手 few-shot 用同一份形态）。 */
export function formatPipelineResult(contract: PipelineContract): string {
  return `${PREFIX} ${JSON.stringify({ verdict: contract.verdict, summary: contract.summary, artifacts: contract.artifacts })}`
}
