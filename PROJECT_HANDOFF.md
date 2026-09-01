# 项目交接

本文件是项目承接入口。当前代码和 Git 状态是事实来源；详细未来方案见 `docs/plans/`，详细实际开发见 `docs/changes/`。

## 项目快照

- 当前目标：为 Run Center 的纯函数补齐分支与边界测试覆盖。
- 当前阶段：`2026-09-01-001` 已实施完成，待随本分支提交。
- 当前分支或提交：`feature/spec-workflow-project-memory`，基线 `origin/develop` @ `220b5fe5`（MR 前已 rebase；任务开始时基线为 `71453450`）。
- 最后更新：2026-09-01。

## 正在进行

| 任务 ID | 状态 | 记录 |
| --- | --- | --- |
| `2026-09-01-001-failure-category-boundaries` | `completed` | [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) |

该任务为 direct work，没有对应 plan；`spec-work` 允许范围明确的直接实施，未事后补造 plan。

## 下一阶段

1. 本分支已 rebase 到 `220b5fe5` 并 force-with-lease 推送，待开 MR 合入 `develop`。
2. 全量 JS 测试已在 `220b5fe5` 重跑并做了 A/B 对照，本任务对失败数无影响；33 个既有失败待另案处理。
3. 后续任务由 `spec-plan` / `spec-work` 按 `YYYY-MM-DD-NNN-<topic>` 继续登记。

## 关键决策与约束

- `PROJECT_HANDOFF.md` 保存当前状态和索引，`docs/plans/` 保存未来方案，`docs/changes/` 保存实际开发。
- 事实优先级：当前代码与 Git > 实际命令结果 > change 记录 > handoff 摘要 > plan。
- 历史摘要只追加；每人只修改自己任务的条目，不改写他人条目。
- task ID 取当日 `NNN` 最大值加一（跨 handoff / plans / archive / changes 统计）；冲突时顺延，禁止覆盖他人记录。归档的 ID 保持占用，不回收。
- 命令未实际执行不得记为 `passed`；未执行即 `not run`。
- `spec-plan` / `spec-work` 由各人自行安装于个人 Claude 配置，**不要求团队成员安装**；本仓库的 `AGENTS.md` 未做任何改动。

## 验证基线

| 检查 | 命令 | 最近结果 | 证据状态 |
| --- | --- | --- | --- |
| 类型检查 | `npm run typecheck` | `passed` | 2026-09-01 rebase 到 `220b5fe5` 后重跑，exit 0 |
| 目标测试 | `npm run test:js -- test/renderer/run-center-attempts.test.ts` | `passed` | 2026-09-01 rebase 后重跑，4/4 |
| 记录校验 | `node scripts/check-spec-records.mjs` | `passed` | 2026-09-01 rebase 后重跑，1 条 change 记录 |
| 全量 JS 测试 | `npm run test:js` | `failed` | 2026-09-01 在 `220b5fe5` 实跑：9953 passed / 33 failed / 13 文件。同基线对照组（不含本任务提交）为 9952 passed / 33 failed / 同一组文件，差值恰为本任务新增的 1 条通过用例 |
| Python 资源测试 | `npm run test:resources` | `not run` | 本轮未执行；`npm test` 的完整结果因此无证据 |

## 已知问题与风险

- `npm test` 存在 30 个既有失败，分布于 11 个文件。主因是本机 PDF 栈环境损坏：`@napi-rs/canvas` 原生绑定缺失、`DOMMatrix is not defined`，波及 `extract-pdf`、`file_indexer`、`file-tools`、`chat_attachments`。
- `test/renderer/run-center.test.ts > builds an overview with health, trend, source, and Agent load signals` 失败，趋势数组整体错位（`[0,0,0,0,1,1,0]` vs `[1,0,0,0,0,1,1]`），疑似按固定日期写死、随日历漂移。
- `test/main/features/skill-trust.test.ts` 2 条 deep re-verification 失败，已验证与本工作流无关（移除本地 skill 后失败不变）。
- 上游 `220b5fe5` 带入两处新失败：`packaged-resource-gate.test.ts`（3 条）与 `messaging.test.ts`（1 条）。在不含本任务提交的对照组中同样失败，与本任务无关。
- 部分用例 flaky：`chat_attachments.test.ts` 在两次运行间为 1↔2 条，`cogseed_backend/runtime-controller.test.ts` 早前失败、后续通过。统计失败数时需留意。
- 以上均非 `2026-09-01-001` 引入，本任务未修复，也未使其恶化。

## 开发历史

- 2026-09-01 · `2026-09-01-001-failure-category-boundaries` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) — 为 `failureCategory` 补齐 5 个分支与 3 类边界断言，仅改测试文件，未动源码。
