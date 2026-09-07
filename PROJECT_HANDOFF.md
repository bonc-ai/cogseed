# 项目交接

本文件是项目承接入口。当前代码和 Git 状态是事实来源；详细未来方案见 `docs/plans/`，详细实际开发见 `docs/changes/`。

## 项目快照

- 当前目标：继续收敛运行与协作 Phase 2/3 的 Windows 实机证据；精确 Electron 视口和可核验 200% 缩放已完成，不扩展 IPC、schema 或业务范围。
- 当前阶段：`2026-09-04-004-run-center-phase3-performance-scale-acceptance` 保持 `partial`；`1440×900`、`1299×768`、`390×844`、`320×640` 与真实 200% 缩放已通过，当前主机为 macOS 且未发现 Windows CLI/虚拟机入口，剩余门槛仅为 Windows 外接 Agent、网关、协作和 Worktree 旅程。`2026-09-04-005-run-center-shared-ui-compliance`、`2026-09-03-003-run-center-phase2-settings-boundary` 保持 `partial`；`2026-09-02-008-run-center-archive-delete-mode-memory` 仍为 `in_progress`；`2026-09-02-006-run-center-modular-ui-cleanup` 保持 `proposed`。
- 当前分支：`codex/run-center-streaming-recovery-20260831`；工作树保留本地运行中心开发改动，未将其推送或并入远端 release 分支。
- 最后更新：2026-09-05（运行中心残留清理、空间中心导航修复与首屏性能优化完成；既有 Windows 门槛不变）。
- 远端 `origin/develop` 已推进至 0.9.0 知识库增强线；公开安全、隐私与许可收口仍以远端最新记录为准，最终 SBOM/verified-only 扫描待具备环境后补跑。

## 正在进行

| 任务 ID | 状态 | 记录 |
| --- | --- | --- |
| `2026-09-05-004-workspace-first-paint-performance` | `completed` | direct work · [change](docs/changes/2026-09-05-004-workspace-first-paint-performance.md)；空间首屏独立、目录按需、短缓存/变更失效及产物可视行恢复；13 项新增 / 172 项关联回归与 macOS 四档恢复态/200% 通过，已普通重启，未提交 |
| `2026-09-05-003-workspace-navigation-recovery` | `completed` | direct work · [change](docs/changes/2026-09-05-003-workspace-navigation-recovery.md)；修复空间入口闪烁、异步串空间、失效目标回落和迟到创建抢导航；23 项新增 / 159 项关联回归及 macOS 新恢复态四档视口、200% 验证通过，保留既有工作树 |
| `2026-09-05-002-run-center-dead-code-cleanup` | `completed` | direct work · [change](docs/changes/2026-09-05-002-run-center-dead-code-cleanup.md)；删除不可达 Overview/图表加载，归一共享模型及重复过滤；183 项回归、1,000 条基准及 macOS Electron 验证通过，完整 JS 仅既有 Bash 路径用例失败 |
| `2026-09-05-001-run-center-sidebar-entry` | `completed` | direct work · [change](docs/changes/2026-09-05-001-run-center-sidebar-entry.md)；按目标截图迁入侧栏搜索/收起之间，复用 IconButton，103 项测试及 macOS Electron 四档视口/200%/触控/跨页验证通过 |
| `2026-09-04-005-run-center-shared-ui-compliance` | `partial` | direct work · [change](docs/changes/2026-09-04-005-run-center-shared-ui-compliance.md)；可直接表达的运行中心动作/空态已改用现有共享原语，产品合同与 2 个复合 Tab 待收敛 |
| `2026-09-04-006-run-center-windows-ci-evidence` | `proposed` | [plan](docs/plans/2026-09-04-006-run-center-windows-ci-evidence-plan.md)；2026-09-05 已修订五项审查问题：Windows unknown 拒绝删除、boot 前数据隔离、release 身份生成、串行测试和应用就绪证明；仅文档修订，业务实现及 Windows CI 均未开始，Phase 2/3 仍为 `partial` |
| `2026-09-04-002-run-center-floating-overlay-fix` | `completed` | direct work；修复全局运行入口跨面板悬浮遮挡 · [change](docs/changes/2026-09-04-002-run-center-floating-overlay-fix.md) |
| `2026-09-04-003-run-center-start-navigation` | `completed` | direct work；修复启动任务成功后错误跳转对话页 · [change](docs/changes/2026-09-04-003-run-center-start-navigation.md) |
| `2026-09-04-004-run-center-phase3-performance-scale-acceptance` | `partial` | [plan](docs/plans/2026-09-04-004-run-center-phase3-performance-scale-acceptance-plan.md) · [change](docs/changes/2026-09-04-004-run-center-phase3-performance-scale-acceptance.md)；四档精确视口与真实 200% 缩放已通过，Windows 环境仍待获得 |
| `2026-09-03-003-run-center-phase2-settings-boundary` | `partial` | [plan](docs/plans/2026-09-03-003-run-center-phase2-settings-boundary-plan.md) · [change](docs/changes/2026-09-03-003-run-center-phase2-settings-boundary.md) |
| `2026-09-04-001-run-center-loading-unblock` | `completed` | direct work；修复统计已更新但任务看板仍停留加载态的问题，13 个聚焦测试文件 / 155 个测试及 macOS Electron 验证通过 |
| `2026-09-03-002-run-center-phase1-p0` | `completed` | 用户确认的运行与协作模块 Phase 1 P0 实施计划；[change](docs/changes/2026-09-03-002-run-center-phase1-p0.md) |
| `2026-09-02-008-run-center-archive-delete-mode-memory` | `in_progress` | direct work；[change](docs/changes/2026-09-02-008-run-center-archive-delete-mode-memory.md) |
| `2026-09-02-007-run-center-correctness-followup` | `completed` | direct work；[change](docs/changes/2026-09-02-007-run-center-correctness-followup.md) |
| `2026-09-02-006-run-center-modular-ui-cleanup` | `proposed` | [plan](docs/plans/2026-09-02-006-run-center-modular-ui-cleanup-plan.md) |
| `2026-09-02-005-run-center-native-controls` | `completed` | [change](docs/changes/2026-09-02-005-run-center-native-controls.md) |
| `2026-09-02-004-run-center-structure-cleanup` | `completed` | [change](docs/changes/2026-09-02-004-run-center-structure-cleanup.md) |
| `2026-09-02-003-run-center-ponytail-audit-cleanup` | `completed` | [change](docs/changes/2026-09-02-003-run-center-ponytail-audit-cleanup.md) |
| `2026-09-02-002-run-center-ponytail-cleanup` | `completed` | [change](docs/changes/2026-09-02-002-run-center-ponytail-cleanup.md) |
| `2026-09-02-001-run-center-persistent-todos` | `partial` | [plan](docs/plans/2026-09-02-001-run-center-persistent-todos-plan.md) · [change](docs/changes/2026-09-02-001-run-center-persistent-todos.md) |
| `2026-09-01-001-failure-category-boundaries` | `completed` | [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) |
| `2026-09-03-001-release-security-cleanup` | `completed` | [change](docs/changes/2026-09-03-001-release-security-cleanup.md) |

`2026-09-01-001-failure-category-boundaries` 为 direct work，没有对应 plan；`spec-work` 允许范围明确的直接实施，未事后补造 plan。

## 下一阶段

1. 实施修订后的 [Windows CI 证据方案](docs/plans/2026-09-04-006-run-center-windows-ci-evidence-plan.md)：先阻止未验证的 Windows Worktree 删除，再补启动前业务隔离、构建身份、应用就绪和串行 CI；Windows 删除成功能力仍需可靠检测方案及实机验证，Phase 2/3 保持 `partial`。
2. 先定位或恢复 `../cogseed-product` 与组件产品清单，决定是扩展 Button/Tab 合同还是新增 RichTab 原语；再迁移 `run-center-detail.js` 仅剩的详情一级 Tab 和 Attempt 复合 Tab，补 Gallery 与键盘验收后将 [shared UI change](docs/changes/2026-09-04-005-run-center-shared-ui-compliance.md) 收敛为 `completed`。
3. 按 [Phase 3 change record](docs/changes/2026-09-04-004-run-center-phase3-performance-scale-acceptance.md) 的恢复入口，在 Windows 实机复核外接 Agent、网关启停锁定、协作动作、Worktree 安全门禁和约定视口；通过后才分别将 Phase 2/3 更新为 `completed`。
4. 1,000 条模型与 HTML 生成基准已经达标，暂不引入分页/窗口化；继续观察真实 Electron paint 与输入延迟，只有出现实测阻断时才另立规模化方案，禁止静默截断。
5. [模块化与 UI 样式收敛方案](docs/plans/2026-09-02-006-run-center-modular-ui-cleanup-plan.md) 保持独立提案，不默认并入 Phase 3。
6. 在任何提交前显式纳入本任务所需的未跟踪运行中心模块、测试、plan 和 change record；本 checkout 的本地 exclude 会隐藏 `docs/plans/` 与 `docs/changes/`。
7. 不在任一任务中引入局部增量渲染或通用组件框架；四档精确视口和真实 200% 已通过，后续只补 Windows 平台门槛。
8. 0.8.0 最终 release 前必须补跑 `trufflehog filesystem . --only-verified`；未完成不得放行最终发版。

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
| 空间首屏性能回归 | `npm run test:js -- test/renderer/workspace-navigation.test.ts ... --maxWorkers=1` | `passed` | 2026-09-05；19 files / 172 tests；语法、typecheck、定向/完整 Lint、diff check 通过；本轮未重跑全量/资源门禁，完整命令见 `2026-09-05-004` change |
| 空间性能与实机 | 慢请求对照 + `scripts/restart-cogseed.sh` + Electron/CDP | `passed` | 450ms 技能/Agent 延迟 fixture：首屏 HTML 450.8–454.1ms → 2.7–5.2ms（非真实 paint）；macOS 热返回两帧 11.0–15.8ms，新恢复态四档/200%、迟到目录和产物可视行通过，真实仅 1 个空间 |
| 空间中心导航修复回归 | `npm run test:js -- test/renderer/workspace-navigation.test.ts ... --maxWorkers=1` | `passed` | 2026-09-05；19 files / 159 tests；新增导航 23 项，语法、typecheck、定向/完整 Lint、diff check 通过；完整命令见 `2026-09-05-003` change |
| 空间中心导航实机 | `scripts/restart-cogseed.sh` + Electron/CDP | `passed` | macOS 重复入口、prepare-before-expose、失效目标/Enter 返回、旧别名通过；新增恢复态四档视口和原生 200% 通过；实际仅 1 个空间，跨空间迟到由 fixture 回归覆盖 |
| 空间修复后全量门禁 | `npm test`；`npm run test:resources` | `failed` / `passed` | 2026-09-05；JS 915 files / 10,250 tests passed，7 files / 32 tests skipped，仅既有 `local-tools.test.ts:498` 失败；资源单独执行 308 passed |
| 运行中心残留清理回归 | `npm run test:js -- test/renderer/run-center*.test.ts ... --maxWorkers=1` | `passed` | 2026-09-05；17 files / 183 tests；语法、typecheck、定向/完整 Lint、diff check、活 CSS/locale 等价比较均通过，完整命令见 `2026-09-05-002` change |
| 清理后性能与实机 | `RUN_CENTER_PERF=1 npm run test:js -- test/renderer/run-center-performance.test.ts --maxWorkers=1` + 重启/CDP | `passed` | 少加载 240,774 bytes JS；1,000 条模型/HTML 的 P95 均低于 6.1 ms；10 组 macOS 布局及 Tab/筛选/旧路由/详情返回通过，实机不再加载 Chart/Overview |
| 清理后全量门禁 | `npm test`；`npm run test:resources` | `failed` / `passed` | 2026-09-05；JS 914 files / 10,227 tests passed，7 files / 32 tests skipped，仅既有 `local-tools.test.ts:498` 失败且单独复现；资源单独执行 308 passed |
| 侧栏运行入口回归 | `npm run test:js -- test/renderer/run-center-global.test.ts ... --maxWorkers=1` | `passed` | 2026-09-05；10 files / 103 tests；语法、typecheck、定向/完整 Lint、diff check 均 exit 0，完整命令见本任务 change |
| 侧栏运行入口实机 | `scripts/restart-cogseed.sh` + Electron/CDP | `passed` | 2026-09-05；10 组布局场景；四档 CSS viewport override、真实 200% zoom、44px coarse touch、reduced-motion、键盘/跨页/懒加载通过；Windows 未运行 |
| 远端同步 | `git fetch origin --prune` + `git merge --no-edit origin/develop` | `passed` | 2026-09-03；合并无代码冲突，远端 develop @ `dc3898f6` 已进入本地分支 |
| 类型检查 | `npm run typecheck` | `passed` | 2026-09-04，exit 0 |
| 运行中心共享 UI 回归 | `npm run test:js -- test/renderer/run-center-global.test.ts ... test/renderer/top-drag-regions.test.ts` | `passed` | 2026-09-04；14 files / 148 tests；覆盖共享入口、空态、详情动作、原生控件预算和真实页面集成 |
| 运行中心共享 UI 实机 | `scripts/restart-cogseed.sh` + macOS Electron 手工检查 | `passed` | 2026-09-04；首页入口/徽标、快速面板正常与空分区、完整任务页、失败详情动作与历史 Attempt 复合 Tab 正常 |
| 运行中心/后端目标回归 | `npm run test:js -- test/main/features/cogseed_backend/*.test.ts test/main/ipc/cogseed-backend.test.ts test/renderer/run-center*.test.ts test/renderer/dashboard-layout-contract.test.ts test/renderer/lazy-features.test.ts test/renderer/renderer-module-entrypoints.test.ts` | `passed` | 59 files / 406 tests |
| 归档与模式记忆回归 | `npm run test:js -- test/main/features/cogseed_backend/task-store.test.ts test/main/features/cogseed_backend/ipc-service.test.ts test/main/ipc/cogseed-backend.test.ts test/renderer/run-center-attempts.test.ts test/renderer/run-center.test.ts test/renderer/dashboard-layout-contract.test.ts` | `passed` | 2026-09-02，6 files / 74 tests |
| 定向 Lint | `npx eslint src/main/features/cogseed_backend/ipc-service.ts src/renderer/modules/run-center.js test/main/features/cogseed_backend/ipc-service.test.ts test/main/features/cogseed_backend/renderer-projection.test.ts test/renderer/dashboard-layout-contract.test.ts` | `passed` | 2026-09-02，exit 0 |
| Phase 2 聚焦测试 | `npm run test:js -- test/renderer/run-center-settings.test.ts ... test/main/ipc/cogseed-backend.test.ts` | `passed` | 2026-09-04；12 files / 149 tests |
| Phase 2 目标 Lint | `npx eslint src/renderer/modules/run-center*.js src/renderer/modules/settings*.js ...` | `passed` | 2026-09-04，exit 0 |
| Python 资源测试 | `npm run test:resources` | `passed` | 2026-09-04；308 passed；仅 LibreSSL/urllib3 警告 |
| SBOM 正式门禁 | `npm run sbom:check` | `passed` | 626 components in sync；旧 `scripts/check-sbom.cjs` 已退出门禁并删除 |
| 生产依赖审计 | `npm audit --omit=dev` | `warnings` | 7 个告警：4 high、2 moderate、1 low、0 critical |
| Phase 1 P0 聚焦测试 | `npm run test:js -- test/renderer/run-center-global.test.ts test/renderer/run-center.test.ts test/renderer/run-center-attempts.test.ts test/renderer/run-center-async-resilience.test.ts test/renderer/run-center-recommended-action.test.ts test/renderer/conversation-info.test.ts test/renderer/dashboard-layout-contract.test.ts test/renderer/lazy-features.test.ts test/renderer/renderer-module-entrypoints.test.ts` | `passed` | 2026-09-03；9 files / 118 tests；布局/全局面板共 20 tests |
| 全量测试 | `npm test` | `failed` | 2026-09-04 Phase 3：913 files passed、7 skipped、2 failed；10,223 tests passed、32 skipped、2 failed；`local-tools.test.ts` 为既有只读 Bash 路径解析失败，Group Chat 为并发静默超时且单独复跑通过 |
| 差异格式 | `git diff --check` | `passed` | 2026-09-04，exit 0 |
| 运行中心加载解除聚焦回归 | `npm run test:js -- test/renderer/run-center-global.test.ts ... test/main/ipc/cogseed-backend.test.ts` | `passed` | 2026-09-04；13 files / 155 tests；任务列表先到、详情迟到场景通过 |
| 运行中心加载解除实机验证 | `scripts/restart-cogseed.sh` + macOS Electron 手工检查 | `passed` | 2026-09-04；统计和任务卡片均正常显示，不再停留“正在加载看板” |
| 全局入口悬浮回归 | `npm run test:js -- test/renderer/run-center-floating-overlay.test.ts test/renderer/run-center-global.test.ts test/renderer/run-center.test.ts test/renderer/dashboard-layout-contract.test.ts` | `passed` | 2026-09-04；4 files / 37 tests |
| 全局入口相关页面回归 | `npm run test:js -- test/renderer/top-drag-regions.test.ts test/renderer/new-chat-home.test.ts test/renderer/lazy-features.test.ts test/renderer/renderer-module-entrypoints.test.ts test/renderer/settings-tabs.test.ts` | `passed` | 2026-09-04；5 files / 67 tests |
| 全局入口修复类型与 Lint | `npm run typecheck`、`npx eslint src/renderer/modules/run-center-global.js src/renderer/modules/boot.js test/renderer/run-center-floating-overlay.test.ts test/renderer/run-center-global.test.ts`、`npm run lint` | `passed` | 2026-09-04；均 exit 0 |
| 全局入口悬浮实机验证 | `scripts/restart-cogseed.sh` + macOS Electron 页面切换 | `passed` | 2026-09-04；运行中心、连接/设置页无覆盖，首页切到连接页会收起快速面板 |
| 启动后导航回归 | `npm run test:js -- test/renderer/run-center.test.ts test/renderer/run-center-async-resilience.test.ts test/renderer/run-center-global.test.ts test/renderer/dashboard-layout-contract.test.ts`、`npm run typecheck`、`npm run lint` | `passed` | 2026-09-04；47 项聚焦测试通过，启动任务保持在运行中心 |
| Phase 3 聚焦回归 | `npm run test:js -- test/renderer/run-center-performance.test.ts ... test/renderer/conversation-info.test.ts` | `passed` | 2026-09-04；10 files / 118 tests；覆盖窄屏单栏优先级和详情态辅助区域显隐 |
| Phase 3 1,000 条基准 | `RUN_CENTER_PERF=1 npm run test:js -- test/renderer/run-center-performance.test.ts` | `passed` | Apple M5 / Node 24；模型、筛选、HTML、Attempt、watch 与后台投影 P95 均低于 8 ms；完整页保留全部 1,000 条 |
| Phase 3 macOS 实机 | `scripts/restart-cogseed.sh` + Electron/CDP 核心旅程 | `passed` | 首页入口、完整页、当前/历史、筛选、Run/Attempt、智能体、协作、设置、任务跳转和返回恢复通过；`1440×900`、`1299×768`、`390×844`、`320×640` 与真实 200% 缩放通过，无页面级横向溢出 |
| Phase 3 Windows 实机 | Windows 外接 Agent、网关、协作、Worktree 与约定视口 | `not run` | 当前 Darwin arm64 主机未发现 Windows CLI 或可用虚拟机入口；Phase 2/3 因此保持 `partial` |
| 记录校验 | `node scripts/check-spec-records.mjs` | `failed` | 当前 checkout 缺少该脚本，无法执行校验逻辑 |

## 已知问题与风险

- 空间中心 `2026-09-05-003` 已修复隐藏预渲染、跨空间迟到覆盖和失效目标回落；macOS 新恢复态窄屏/200% 通过，但本机只有 1 个真实空间，真实双空间压力旅程未运行，A→B→A 由可控 IPC fixture 回归覆盖。本任务不改变既有 Windows 或共享组件产品合同门槛。
- `2026-09-04-005` 将拆分后运行中心的原生控件预算从 52 收紧到 33；`run-center-detail.js` 仍有 2 个复合 roving Tab 按钮，因现有 `uiButton` 不支持富内容和 `tabindex` attrs 未强行迁移。当前工作区也未找到 `../cogseed-product` 产品合同仓库，需恢复后先做组件合同决策。
- 2026-09-05 `npm test` 仅复现既有 `test/main/model/core-agent/local-tools.test.ts:498` 的只读 Bash 路径判断失败，单独复跑仍失败；历史 Group Chat 并发静默超时本轮未复现。运行中心目标回归 183 项全部通过，不将全仓库门禁失败误报为清理回归或绿色门禁。
- 旧 Overview 残留已在 `2026-09-05-002` 清理，完整中心不再加载 Chart.js；vendored Chart.js 及其许可证/发行声明本轮保留，若后续清理发布资源需一并核对打包引用。旧路由兼容目标和 ARIA 隐藏 TabPanel 仍属活代码。
- 当前 checkout 没有交接文档引用的 `scripts/check-spec-records.mjs`，因此记录校验命令无法执行；未在本任务中重建该工具。
- Phase 3 的模型和 HTML 生成基准不等同于真实 Electron paint/输入延迟；当前未引入分页或虚拟列表，若后续低端设备实测不达标需单独立项，不能静默截断。
- `run-center-detail.js`、`run-center-global.js`、`run-center-model.js`、`run-center-settings.js` 及运行中心新增测试仍未被 Git 跟踪；本地 exclude 还隐藏 plan/change 目录，提交前需要显式纳入。
- 全局运行入口已按用户目标截图迁入侧栏搜索/收起按钮之间，跨页常驻但不占用页面顶部；快速面板仅主动打开时显示，切页收起，常驻 watch 保留。折叠/窄栏保留运行图标，详见 `2026-09-05-001` change。
- 运行中心看板此前因任务列表、Agent 注册表和详情读取串行等待而出现加载阻塞；`2026-09-04-001-run-center-loading-unblock` 已拆分刷新生命周期并验证修复。若再次出现，优先检查 `run-center.js` 中 `cogseed.task.list` 返回后的 `state.loading` 收敛和详情后台刷新。
- 工作树继续包含本任务之外的大量既有改动与删除；不得整树回退或把它们归入本次远端同步。
- “删除全部归档”安全地按目录扫描；在扫描已经越过某文件后才新归档的任务会留给下一次清理，不会被错误删除或影响待写回结果。
- 当前只有 macOS 实机证据；未发现 `cmd.exe`、`powershell.exe` 或 QEMU、VirtualBox、Parallels、VMware 入口，Windows 外接 Agent、网关、协作动作和 Worktree 安全流程仍待验收。
- `trufflehog filesystem . --only-verified` 尚未执行，是 0.8.0 最终 release 阻断条件；不影响本地 develop 同步。

## 开发历史

- 2026-09-01 · `2026-09-01-001-failure-category-boundaries` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-01-001-failure-category-boundaries.md) — 为 `failureCategory` 补齐 5 个分支与 3 类边界断言，仅改测试文件，未动源码。
- 2026-09-02 · `2026-09-02-001-run-center-persistent-todos` · `partial` · [plan](docs/plans/2026-09-02-001-run-center-persistent-todos-plan.md) · [change](docs/changes/2026-09-02-001-run-center-persistent-todos.md) — 持久化待办、原任务启动、无确认归档、隐私投影和目标回归已完成；精确 Electron 尺寸矩阵待补。
- 2026-09-02 · `2026-09-02-002-run-center-ponytail-cleanup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-02-002-run-center-ponytail-cleanup.md) — 删除旧任务级过滤适配和不可达回退，统一走运行级主路径；运行中心 Renderer 50/50 通过。
- 2026-09-02 · `2026-09-02-003-run-center-ponytail-audit-cleanup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-02-003-run-center-ponytail-audit-cleanup.md) — 删除固定加载顺序下不可达的模块回退、测试专用包装和被完全覆盖的旧 CSS；关联回归 401/401 通过。
- 2026-09-02 · `2026-09-02-004-run-center-structure-cleanup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-02-004-run-center-structure-cleanup.md) — 将尝试模型归位到 Board、详情渲染拆为独立模块，并收敛选择、导航、创建、搜索和焦点重复路径；关联回归 402/402 通过。
- 2026-09-02 · `2026-09-02-005-run-center-native-controls` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-02-005-run-center-native-controls.md) — 用原生 dialog/details/progress 替换自写弹层、焦点陷阱、折叠状态和进度条基础设施；关联回归 402/402 通过。
- 2026-09-02 · `2026-09-02-006-run-center-modular-ui-cleanup` · `proposed` · [plan](docs/plans/2026-09-02-006-run-center-modular-ui-cleanup-plan.md) — 计划按创建、诊断、Worktree、主编排和独立 CSS 建立明确边界；允许有维护收益的 UI 收敛，不改后端合同。
- 2026-09-02 · `2026-09-02-007-run-center-correctness-followup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-02-007-run-center-correctness-followup.md) — 保存待办输入、空间目录边界、恢复态统计、队列筛选反馈和窄屏页签偏移已修复；运行中心关联回归 406/406 通过，Git 未跟踪详情模块与真实 Electron 精确视口验收仍待处理。
- 2026-09-02 · `2026-09-02-008-run-center-archive-delete-mode-memory` · `in_progress` · 无 plan（direct work）· [change](docs/changes/2026-09-02-008-run-center-archive-delete-mode-memory.md) — 继续处理归档清理、取消运行和列表/看板模式记忆。
- 2026-09-03 · `2026-09-03-001-release-security-cleanup` · `completed` · 无 plan（direct work）· [change](docs/changes/2026-09-03-001-release-security-cleanup.md) — 清理真实配置痕迹、退出旧 SBOM 计数门禁、补齐 `exif-parser` MIT 证据，并保留 fixture 豁免与 TruffleHog release 阻断条件。
- 2026-09-03 · `2026-09-03-002-run-center-phase1-p0` · `completed` · 用户确认实施计划 · [change](docs/changes/2026-09-03-002-run-center-phase1-p0.md) — 按运行与协作 PRD v0.4 完成全局入口、任务/智能体/协作信息架构、任务详情跳转和返回上下文闭环。
- 2026-09-03 · `2026-09-03-003-run-center-phase2-settings-boundary` · `proposed` · [plan](docs/plans/2026-09-03-003-run-center-phase2-settings-boundary-plan.md) — 计划收敛智能体监控与配置边界，保留跨任务协作工作区，并将 Agent/网关、诊断和 Worktree 管理归入“设置—配置”。
- 2026-09-04 · `2026-09-03-003-run-center-phase2-settings-boundary` · `partial` · [plan](docs/plans/2026-09-03-003-run-center-phase2-settings-boundary-plan.md) · [change](docs/changes/2026-09-03-003-run-center-phase2-settings-boundary.md) — 本地实现与自动化回归完成；智能体只读监控、协作目标保护和设置配置归位已交付，精确视口、200% 缩放及 Windows 实机验收待补。
- 2026-09-04 · `2026-09-04-001-run-center-loading-unblock` · `completed` · direct work · [change](docs/changes/2026-09-04-001-run-center-loading-unblock.md) — 修复任务统计先到而看板仍加载的异步竞态；任务列表先渲染、Agent/详情后台刷新，迟到响应和选择保护回归通过，macOS Electron 实机确认任务卡片正常显示。
- 2026-09-04 · `2026-09-04-002-run-center-floating-overlay-fix` · `completed` · direct work · [change](docs/changes/2026-09-04-002-run-center-floating-overlay-fix.md) — 限制全局入口只出现在首页工具栏，切页关闭快速面板，避免运行中心、连接和设置顶部被悬浮元素遮挡；37 项目标回归与 macOS Electron 页面切换验证通过。
- 2026-09-04 · `2026-09-04-003-run-center-start-navigation` · `completed` · direct work · [change](docs/changes/2026-09-04-003-run-center-start-navigation.md) — 修复新建任务启动成功后自动跳转普通对话页；运行中心保持选中运行摘要，主动点击运行条目仍可打开对话；47 项聚焦回归、类型检查、Lint 和运行时重启通过。
- 2026-09-04 · `2026-09-04-004-run-center-phase3-performance-scale-acceptance` · `partial` · [plan](docs/plans/2026-09-04-004-run-center-phase3-performance-scale-acceptance-plan.md) · [change](docs/changes/2026-09-04-004-run-center-phase3-performance-scale-acceptance.md) — 完成 1,000 条安全投影基准、派生模型复用、状态/ARIA/触控/reduced-motion 收敛和 macOS 核心旅程；精确视口、可核验 200% 缩放与 Windows 验收待补。
- 2026-09-04 · `2026-09-04-005-run-center-shared-ui-compliance` · `partial` · direct work · [change](docs/changes/2026-09-04-005-run-center-shared-ui-compliance.md) — 全局入口、快速面板三空态、详情动作和完整页通用空态已复用共享原语，原生控件预算从 52 降至 33；产品合同与 2 个复合 Tab 待收敛。
- 2026-09-04 · `2026-09-04-004-run-center-phase3-performance-scale-acceptance` · `partial` · 验收补充 · [change](docs/changes/2026-09-04-004-run-center-phase3-performance-scale-acceptance.md) — 修复窄屏看板详情宽度归零，`1440×900`、`1299×768`、`390×844`、`320×640` 与真实 200% 缩放验收通过；仅剩 Windows 平台门槛。
- 2026-09-05 · `2026-09-04-006-run-center-windows-ci-evidence` · `proposed` · [plan](docs/plans/2026-09-04-006-run-center-windows-ci-evidence-plan.md) — 修正五项方案审查问题，明确 Windows 未验证占用时禁用删除、bootstrap 前隔离、release 身份生成、单 worker 和真实 boot/按需模块就绪；本次仅文档修订，业务实现与 Windows CI 均未开始，未新增 change record。
- 2026-09-05 · `2026-09-05-001-run-center-sidebar-entry` · `completed` · direct work · [change](docs/changes/2026-09-05-001-run-center-sidebar-entry.md) — 按截图将首页文字入口迁为侧栏脉冲图标＋状态徽标，复用共享 IconButton；保留跨页快速面板并补齐定位、焦点/IME/Escape 层级保护；103 项测试及 macOS Electron 四档视口/200%/触控验证通过，仅本地未提交。
- 2026-09-05 · `2026-09-05-002-run-center-dead-code-cleanup` · `completed` · direct work · [change](docs/changes/2026-09-05-002-run-center-dead-code-cleanup.md) — 删除不可达 Overview、图表加载、238 条样式及 92 条翻译，移除重复模型并合并过滤；完整中心少加载约 241 KB JS，183 项回归、1,000 条基准及 macOS Electron 核心旅程通过；全量 JS 仅既有 Bash 路径测试失败，资源 308 passed，保留用户改动且未提交。
- 2026-09-05 · `2026-09-05-003-workspace-navigation-recovery` · `completed` · direct work · [change](docs/changes/2026-09-05-003-workspace-navigation-recovery.md) — 修复空间入口闪烁、迟到响应串空间、失效目标回落和慢创建抢导航；复用共享恢复态与现有窄栏，23 项新增/159 项关联回归及 macOS 新恢复态视口/200% 通过；全量 10,250 passed，仅既有 Bash 路径失败，资源 308 passed，已正常重启且未提交。
- 2026-09-05 · `2026-09-05-004-workspace-first-paint-performance` · `completed` · direct work · [change](docs/changes/2026-09-05-004-workspace-first-paint-performance.md) — 解耦空间首屏与能力目录、增加短缓存及变更失效，保留导航版本保护并修复产物可视行恢复；13 项新增/172 项关联回归、慢请求对照和 macOS 四档新恢复态/200% 通过，已恢复普通启动且未提交；本轮未跑全量门禁，Windows 门槛不变。
- 2026-09-06 · `origin/develop` · `partial` — 远端包含 0.9.0 知识库问答、文件预览、流式 IPC 与任务自动归档更新；本次合并已保留相关代码，完整门禁待在合并后重新执行。
