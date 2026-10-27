/**
 * coding-workflow built-in skill (PLAN-coding-contract P2): the long-tail
 * layer UNDER the always-on engineering contract. The frozen core carries the
 * four decidable rules (read-before-write, verify-before-claim, no invented
 * API, match the surroundings); this skill is keyword-triggered and only
 * ROUTES — the per-scenario discipline lives in resources (see
 * coding-workflow-references.ts, split off on the office skill's pattern),
 * pulled on demand via pick_skill, exactly like the office skill's references.
 *
 * The routing table below must name ONLY files that ship in
 * CODING_WORKFLOW_REFERENCES — tests/skill-resources.test.ts pins that every
 * `references/*.md` named in a SKILL.md body has a declared resource.
 */

export const CODING_WORKFLOW_PROMPT = `## Active Skill: Coding Workflow

The always-on Engineering Workflow rules apply unchanged — this skill adds HOW to organize a piece of code work that is bigger than a few lines. Route first, then pull the matching reference with pick_skill's disk-fresh read (or read the file directly from the skill directory):

| Situation | Read | Why |
|-----------|------|-----|
| 改动 > ~5 个文件 / 顶层结构移动 / 行为保持的重写 | \`references/refactor-large.md\` | 先立安全网再动手；机械步与行为步分开提交 |
| 用户要求 review / 评审 / 找问题（不是改代码） | \`references/code-review.md\` | 按清单过，输出按严重级别分级，不做没有证据的断言 |
| 框架/语言/依赖迁移、大版本升级、schema/数据搬迁 | \`references/migration.md\` | 顺序是成败关键：锁边界 → 升依赖 → 修调用点 → 全量验证 |
| bug 报告 / 「为什么不对」/ 间歇性故障 / 崩溃 | \`references/debug-root-cause.md\` | 先稳定复现再动手；修复 = 根因 + 回归钉子，不是压症状 |
| 新功能 / 明显的能力增量（超出几行的小改） | \`references/feature-delivery.md\` | 先收窄验收标准、找既有模式，再分阶段落地 |
| 「太慢」「卡」「内存涨」等性能问题 | \`references/performance.md\` | 没有测量就没有优化：基线 → 定位 → 一次一变 → 同口径复测 |

### Choosing a route
- 按用户的主要意图选路线，不按表面词汇：「升级时顺手 review」以 migration 为主线、review 作收尾检查；「修这个 bug 顺便调下命名」以 debug 为主线，命名归入最小修复之外。
- 路线可以串行：大迁移途中的行为步遵守 refactor-large 的提交纪律；bug 修复带出结构改动时，先修根因、重构另行开局。
- 没有路线合适（几行内的小改动、纯问答、单纯解释代码）→ 一句话说明不走路线，直接按核心四规则做。

### Rules that hold on every route
- State the route in one line before working (「这是一次大重构，我会先…」) so the user can correct the scale early.
- Verify with the project's own commands (the Engineering Workflow #2) at every checkpoint the reference names — a route without working verification is a guess with extra steps.
- References are the default process, not a mandate: the user's explicit process requirement wins. If the actual work turns out smaller than the route assumed, STOP using the heavyweight process and say so; the route serves the work, not the reverse.`
