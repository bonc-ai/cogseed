# 项目交接

本文件是项目承接入口。当前代码和 Git 状态是事实来源；详细未来方案见 `docs/plans/`，详细实际开发见 `docs/changes/`。

## 项目快照

- 当前目标：完成 0.8.0 发版前的远端安全与敏感内容收口。
- 当前阶段：`2026-09-03-001` 已实施完成，`2026-09-03-002` 已完成 develop → cicd promotion，PR #169 等待远端审核；未批准 0.8.0 最终 release。
- 当前分支：`promotion/develop-to-cicd-20260903`，promotion 合并提交 `853ac7b0`；基线 `origin/cicd` @ `dbc2db67`，已合入 `origin/develop` @ `dc3898f6`。
- 最后更新：2026-09-03。

## 正在进行

| 任务 ID | 状态 | 记录 |
| --- | --- | --- |
| `2026-09-03-002-promote-develop-to-cicd` | `completed` | 基于最新 `origin/cicd` 建立隔离 promotion 分支，合入 `origin/develop` 并解决 45 处同步冲突；验证通过，已推送并创建 PR #169 等待审核 |
| `2026-09-01-001-failure-category-boundaries` | `completed` | [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) |
| `2026-09-03-001-release-security-cleanup` | `completed` | [change](docs/changes/2026-09-03-001-release-security-cleanup.md) |

该任务为 direct work，没有对应 plan；`spec-work` 允许范围明确的直接实施，未事后补造 plan。

## 下一阶段

1. 跟进 PR #169 的 `verify` 与 `verify-windows`，不直接合并。
2. 最终 release 前必须补跑 `trufflehog filesystem . --only-verified`；未完成不得放行 0.8.0。
3. 本次 Electron JS 全量测试为 911 个测试文件通过、7 个跳过；Python 资源测试 308 个通过。
4. 后续任务由 `spec-plan` / `spec-work` 按 `YYYY-MM-DD-NNN-<topic>` 继续登记。

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
| 类型检查 | `npm run typecheck` | `passed` | 2026-09-03 在 `origin/develop` 隔离清理分支重跑，exit 0 |
| 目标测试 | `npx vitest run ...gateway-models-probe...` + guardrail 专项 | `passed` | 2026-09-03：37/37 + 40/40 |
| 记录校验 | `node scripts/check-spec-records.mjs` | `not run` | 当前 `origin/develop` 不包含该脚本 |
| 全量 JS 测试 | `npm run test:js -- --maxWorkers=2` | `passed` | 2026-09-03：10176 passed / 32 skipped，Electron ABI 已恢复 |
| Python 资源测试 | `npm run test:resources` | `passed` | 2026-09-03：308 passed |
| SBOM 正式门禁 | `npm run sbom:check` | `passed` | 626 components in sync；旧 `scripts/check-sbom.cjs` 已退出门禁并删除 |
| 生产依赖审计 | `npm audit --omit=dev` | `warnings` | 7 个告警：4 high、2 moderate、1 low、0 critical；本任务未改锁文件 |

## 已知问题与风险

- `npm run test:resources:setup` 在本机因包索引没有 `pytest==9.1.1` 未完成；已有 `npm run test:resources` 仍通过。
- `test/renderer/run-center.test.ts > builds an overview with health, trend, source, and Agent load signals` 失败，趋势数组整体错位（`[0,0,0,0,1,1,0]` vs `[1,0,0,0,0,1,1]`），疑似按固定日期写死、随日历漂移。
- `test/main/features/skill-trust.test.ts` 2 条 deep re-verification 失败，已验证与本工作流无关（移除本地 skill 后失败不变）。
- 上游 `220b5fe5` 带入两处新失败：`packaged-resource-gate.test.ts`（3 条）与 `messaging.test.ts`（1 条）。在不含本任务提交的对照组中同样失败，与本任务无关。
- 部分用例 flaky：`chat_attachments.test.ts` 在两次运行间为 1↔2 条，`cogseed_backend/runtime-controller.test.ts` 早前失败、后续通过。统计失败数时需留意。
- 以上均非本 promotion 引入，本任务未修改其业务行为，也未使其恶化。
- `trufflehog filesystem . --only-verified` 尚未执行，是 0.8.0 最终 release 阻断条件，不阻塞本次 `develop` 合并审核。
- 当前锁文件的生产依赖审计有 7 个告警（4 high、2 moderate、1 low），需在最终 release 审核中另行处置或接受风险；不属于本 cleanup 差异引入。

## 开发历史

- 2026-09-01 · `2026-09-01-001-failure-category-boundaries` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) — 为 `failureCategory` 补齐 5 个分支与 3 类边界断言，仅改测试文件，未动源码。
- 2026-09-03 · `2026-09-03-001-release-security-cleanup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-03-001-release-security-cleanup.md) — 清理真实配置痕迹、退出旧 SBOM 计数门禁、补齐 `exif-parser` MIT 证据，并保留 fixture 豁免与 TruffleHog release 阻断条件。
