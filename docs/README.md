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
