# 进化控制台（Evolution Console）

用本仓库技术栈重建的 Meta-Skill 六页进化控制台。以 Python+React 原型「meta-skill-4版」为蓝本，
功能对齐、技术栈重写：**Electron 单进程 / Node main / vanilla 渲染层 / 进程内引擎 + core-agent**，
不引入 HTTP 服务、打包器或第三方前端框架。

## 是什么

对已有技能做「演化 / 治理」闭环的工作台，与「技能库」分工：

- **技能库** —— 技能本身的浏览、新建、编辑、导入。
- **进化控制台** —— 选一个技能，对它跑 KSTAR 7 步演化、评估、本体绑定、补丁审批、版本演进。

六页：总览 / 技能（选择器）/ 进化 / 本体 / 评估 / 补丁。入口为独立全屏视图 `panel-evolution`
（侧栏「进化控制台」按钮 + 聊天顶栏切换）。

## 架构（四层）

| 层 | 位置 | 职责 |
|---|---|---|
| 渲染层 | `src/renderer/modules/evolution/{pages,console}.js` | classic script 六页渲染 + 交互，经 `ipc-shim` 走 `/api/evolution/*` |
| IPC 层 | `src/main/ipc/index.ts` 的 `evolution.*` 通道 | 薄校验转发，零业务逻辑 |
| Feature 层 | 本目录 | 编排 + core-agent 接线 + 数据读写 |
| 引擎层 | `packages/nseap-meta-skill-engine`（ESM，进程内动态 import） | KSTAR 引擎、本体、评估、补丁生成 |

## 本目录文件

- `engine-loader.ts` —— 唯一的进程内引擎加载点，动态 import 引擎 `dist/engine.js`（纯库入口，不启动 MCP 服务器）。
- `llm-bridge.ts` —— 把 core-agent 的 `buildRunner` 包成引擎所需的 `LlmComplete`；空返回/抛错降级并标 `degraded`，模型跟 Orkas agent 同步。
- `orchestrator-bridge.ts` —— 驱动引擎 `EvolutionOrchestrator` 跑 KSTAR 7 步，状态落 `local/kstar/evolution/<runId>.json`。
- `evals-store.ts` —— 评估用例 / 逐断言流式判定 / 人写评估标准（含就绪门槛），落 `local/kstar/evals/<skillId>.json`。
- `dashboard.ts` —— 聚合技能计数、待审补丁、进化活跃度（依赖失败降级不外抛）。
- `ontology-service.ts` / `ontology-bindings.ts` —— 本体 LLM 抽取 + 写入、技能↔本体绑定；本体源落 `cloud/skills/<id>/ontology/`。
- `versions-store.ts` —— 技能版本历史，Apply 成功后追加，落 `local/kstar/versions/<id>.json`。
- `export-service.ts` —— 技能目录打 zip 到 `local/kstar/exports/`（复用 adm-zip）。
- `create-wizard.ts` —— 创建向导：意图捕获（引擎，无副作用）+ 委托既有 `skills.createCustomSkill` 沙箱建目录。
- `recommend-service.ts` —— 从绑定领域本体规则 + 高 ΔR 交互记录 + 个人本体偏好生成进化建议。
- `index.ts` —— 对外 barrel 导出。

## 数据落点

- 派生的机器态（编排 / 评估 / 版本 / 导出）→ `<uid>/local/kstar/`
- 用户资产（技能正文 SKILL.md、本体源）→ `<uid>/cloud/skills/`

## LLM 与降级

Propose / Evaluate / 本体抽取经 core-agent；不可用时降级为确定性规则并标 `degraded: true`，
UI 显式提示「规则降级」，绝不产生误导性假结果。

## 测试

镜像目录 `test/main/features/evolution/`、`test/main/ipc/`、`test/renderer/`。
运行：`node scripts/run-tests.mjs run <path>`。引擎侧：`cd packages/nseap-meta-skill-engine && npx vitest run`。
