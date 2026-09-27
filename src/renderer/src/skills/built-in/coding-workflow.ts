/**
 * coding-workflow built-in skill (PLAN-coding-contract P2): the long-tail
 * layer UNDER the always-on engineering contract. The frozen core carries the
 * four decidable rules (read-before-write, verify-before-claim, no invented
 * API, match the surroundings); this skill is keyword-triggered and only
 * ROUTES — the per-scenario discipline (large-refactor staging, review
 * checklist, migration order) lives in resources, pulled on demand via
 * pick_skill, exactly like the office skill's references.
 */

export const CODING_WORKFLOW_PROMPT = `## Active Skill: Coding Workflow

The always-on Engineering Workflow rules apply unchanged — this skill adds HOW to organize a piece of code work that is bigger than a few lines. Route first, then pull the matching reference with pick_skill's disk-fresh read (or read the file directly from the skill directory):

| Situation | Read | Why |
|-----------|------|-----|
| 改动 > ~5 个文件 / 顶层结构移动 / 行为保持的重写 | \`references/refactor-large.md\` | 先立安全网再动手；机械步与行为步分开提交 |
| 用户要求 review / 评审 / 找问题（不是改代码） | \`references/code-review.md\` | 按清单过，输出按严重级别分级，不做没有证据的断言 |
| 框架/语言/依赖迁移、大版本升级 | \`references/migration.md\` | 顺序是成败关键：锁边界 → 升依赖 → 修调用点 → 全量验证 |

### Rules that hold on every route
- State the route in one line before working (「这是一次大重构，我会先…」) so the user can correct the scale early.
- Verify with the project's own commands (the Engineering Workflow #2) at every checkpoint the reference names — a route without working verification is a guess with extra steps.
- If the actual work turns out smaller than the route assumed, STOP using the heavyweight process and say so; the route serves the work, not the reverse.`

export const CODING_WORKFLOW_REFERENCES: Record<string, string> = {
  'references/refactor-large.md': `# 大重构怎么拆

目标：行为保持的重写要在每一步都可验证、可停止、可回退。

## 1. 先立安全网（动手前）
- 找到/补上能证明「行为没变」的最小验证集：现有测试、类型检查、可执行的入口。一个都没有时，先为**将被移动的现有行为**写测试（不是为新设计写）。
- 记录基线：改造前跑一遍验证命令，贴出输出（Engineering Workflow #2）。git 状态干净再开始。

## 2. 机械步与行为步分离
- 机械步（纯移动/改名/提取函数）：不改变任何行为，一次一批，每批后验证。适合多做快跑。
- 行为步（改逻辑）：一次一个意图，前后各验证一次。机械步里发现的行为变化要么修掉并说明，要么单独成步——绝不顺手夹带。

## 3. 提交粒度
- 每个可验证的批次 commit 一次（Conventional Commits，机械步标 refactor、行为步标 feat/fix）。回退单元 = 提交单元。

## 4. 中途失守的规则
- 验证红了且两轮修不回来：停，向用户报告已完成的批次、红的具体原因、建议的回退点。不要用「再大改一轮」掩盖。
`,
  'references/code-review.md': `# 代码 review 清单

产出格式固定为三段：**结论**（可合并 / 需修改 / 阻塞）、**问题分级列表**、**未覆盖项**。

## 分级（每条问题必须落档其中一级）
- 阻塞：数据丢失、安全（注入/越权/密钥泄漏）、明显会导致生产事故的错误
- 严重：逻辑错误、边界条件遗漏、错误处理缺失、破坏既有 API 契约
- 一般：测试缺口、命名/结构问题、重复代码、性能隐患
- 轻微：风格、注释、小的不良味道

## 过一遍的顺序
1. 契约面：对外接口/返回值/错误路径是否自洽且与调用方匹配
2. 正确性：边界（空、0、并发、超长、重入）、资源释放、异步竞态
3. 安全：输入信任边界、路径拼接、权限、日志里的敏感值
4. 测试：改了行为的测试在吗？只看新增测试是否真的断言了新行为
5. 一致性：与周围代码的命名/错误处理/注释风格（Engineering Workflow #4）

## 纪律
- 每条问题给出文件:行号与一句话理由；没有证据的猜测明确标注「未验证的怀疑」。
- 不顺手改代码，除非用户明确要求 fix 模式；改了就逐条对应 review 结论。
`,
  'references/migration.md': `# 迁移 / 大版本升级

顺序是成败关键，颠倒一步 = 大面积返工。

## 1. 锁定边界（升级前）
- 枚举被迁移对象的所有调用点（search 全仓），记录当前版本的行为基线并跑通验证。
- 冻结范围：迁移期间不夹带任何新功能。

## 2. 升依赖
- 一次升一个大版本（跨多版本时逐级走），先读该版本的 breaking changes 清单再动代码。
- lockfile 变更单独成提交。

## 3. 修调用点
- 按「叶子 → 上游」的顺序改调用点，每改完一层验证一层。
- 官方 codemod 优先于手改；手改前先 search 确认没有漏网的旧 API（Engineering Workflow #3 的反向应用：确认所有旧用法都消失了）。

## 4. 全量验证
- 完整跑构建/测试/lint 三件套，贴原始输出。
- 回归点：类型检查对旧用法的残留（deprecation warning）、文档中的版本号、CI/脚本里的硬编码路径。

## 失败回退
- 依赖回退 = revert lockfile + 调用点提交；每一步独立成提交，让这条回退路径始终存在。
`,
}
