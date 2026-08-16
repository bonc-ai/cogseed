# CogSeed 文档总览

## 当前开发口径

- `develop` 是受保护的功能开发与集成基线；所有改动通过 `dev/*` 分支和 GitLab MR 进入。
- `main` 是经过验证的正式发布镜像，不承载独立开发提交。
- Electron 主进程、classic renderer、IPC allow-list、用户数据域和测试方式以仓库根目录 [`AGENTS.md`](../AGENTS.md) 为准。
- 当前产品身份以 `src/resources/brand.json`、`src/resources/identity.json` 和 `src/main/brand.ts` 为准。

## 主要设计入口

- [`superpowers/specs/2026-08-11-cogseed-official-cutover-design.md`](./superpowers/specs/2026-08-11-cogseed-official-cutover-design.md) — CogSeed 正式仓库/品牌切换
- [`superpowers/specs/2026-08-10-cogseed-full-identity-migration-design.md`](./superpowers/specs/2026-08-10-cogseed-full-identity-migration-design.md) — App ID、协议、数据根、IPC 和 Runtime 身份迁移
- [`superpowers/specs/2026-08-10-cogseed-brand-cognition-navigation-design.md`](./superpowers/specs/2026-08-10-cogseed-brand-cognition-navigation-design.md) — 产品品牌与 Cognition 导航

### P3394 开发指导（核心）

- [`P3394-Bridge-Runtime-实施指挥书.md`](./P3394-Bridge-Runtime-实施指挥书.md) — Bridge Runtime 实施指挥书
- [`P3394-会议对照与Dashboard后续事项-2026-08-16.md`](./P3394-会议对照与Dashboard后续事项-2026-08-16.md) — 今日会议对照、Dashboard 候选范围与进入条件
- [`P3394-Conformance-Matrix.md`](./P3394-Conformance-Matrix.md) — P3394 规范符合性矩阵与实施证据索引
- [`P3394_Local_Bridge_SDK_Design(1).md`](./P3394_Local_Bridge_SDK_Design(1).md) — Local Bridge SDK 设计
- [`P3394_Raymond_Hermes_Chinese_Implementation_Guide.md`](./P3394_Raymond_Hermes_Chinese_Implementation_Guide.md) — P3394 协议中文实施指南
- [`superpowers/handover-p3394-bridge-runtime.md`](./superpowers/handover-p3394-bridge-runtime.md) — Bridge Runtime 交接文档
- [`superpowers/plans/2026-08-13-p3394-bridge-runtime.md`](./superpowers/plans/2026-08-13-p3394-bridge-runtime.md) — Bridge Runtime 实施计划
- [`superpowers/specs/2026-08-13-p3394-bridge-runtime-design.md`](./superpowers/specs/2026-08-13-p3394-bridge-runtime-design.md) — Bridge Runtime 设计规格
- [`superpowers/specs/2026-08-10-cogseed-production-architecture.md`](./superpowers/specs/2026-08-10-cogseed-production-architecture.md) — CogSeed（P3394）生产级架构

### 飞书 / 微信机器人

- [`Cogseed-Hermes-飞书-MVP实施计划.md`](./Cogseed-Hermes-飞书-MVP实施计划.md) — 飞书 MVP 实施计划
- [`touchpoint-v2-quickstart.md`](./touchpoint-v2-quickstart.md) — 飞书触点 v2 快速上手
- [`superpowers/plans/2026-08-08-wechat-personal-ilink.md`](./superpowers/plans/2026-08-08-wechat-personal-ilink.md) — 个人微信（iLink）接入计划
- [`superpowers/specs/2026-08-08-wechat-personal-ilink-design.md`](./superpowers/specs/2026-08-08-wechat-personal-ilink-design.md) — 微信接入设计规格
- [`superpowers/specs/2026-08-10-feishu-companion-context-design.md`](./superpowers/specs/2026-08-10-feishu-companion-context-design.md) — 飞书伴侣上下文设计

### KSTAR / Recall（认知闭环核心）

- [`superpowers/plans/2026-08-14-commander-centric-kstar.md`](./superpowers/plans/2026-08-14-commander-centric-kstar.md) — Commander 中心 KStar 实施计划
- [`superpowers/specs/2026-08-14-commander-centric-kstar-design.md`](./superpowers/specs/2026-08-14-commander-centric-kstar-design.md) — KStar 设计
- [`superpowers/specs/2026-08-13-kstar-recall-world-model-closed-loop-design.md`](./superpowers/specs/2026-08-13-kstar-recall-world-model-closed-loop-design.md) — KSTAR×Recall 世界模型闭环
>>>>>>> 7f7a9e83 (feat(p3394): 模型纠偏与真实 Runtime/Channel 恢复加固)
- [`superpowers/specs/2026-08-09-recall-prd-information-architecture-design.md`](./superpowers/specs/2026-08-09-recall-prd-information-architecture-design.md) — Recall/Cognition 信息架构

## 关键实现位置

- `src/main/features/group_chat/` — 多 Agent 会话、计划和调度
- `src/main/features/recall/` — Cognition/Recall 捕获、资产、投影和证明
- `src/main/features/cogseed_runtime/` — 隔离 Runtime worker
- `src/main/features/cogseed_backend/` — 任务和能力后端
- `src/main/features/local_agents/` — 本地 CLI Agent
- `src/main/features/connectors/` — OAuth 与 MCP Connector

## 验证命令

```bash
npm run typecheck
npm test
scripts/restart-cogseed.sh
```

如果 SQLite Electron ABI 异常：

```bash
npm run rebuild:sqlite:electron
```

## 迁移兼容

CogSeed 是当前正式身份。`mateagent://`、`orkas://`、`ORKAS_*` 和 `.orkas` 仅保留一个发布周期用于旧回调、环境和数据迁移；新代码和新文档必须使用 CogSeed canonical 标识。
