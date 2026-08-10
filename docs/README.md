# CogSeed 文档总览

> 2026-08-10 更新：仓库内置的 Meta Skill Engine / 独立进化控制台线已从当前工作树移除。完整实现已保留在分支 `dev/archive-meta-skill-evolution-console`，worktree：`/Users/sudai/.config/codex/worktrees/CogSeed/meta-skill-evolution-preserve`。当前工作树不再携带 bundled KSTAR engine；P3394 仅在显式配置外部 engine 时连接：`ORKAS_KSTAR_ENGINE_COMMAND` + `ORKAS_KSTAR_ENGINE_ARGS`。

## 当前开发口径

- `develop` 是功能开发与集成基线；受保护分支不得直接推送。
- Electron 主进程、renderer classic scripts、IPC allow-list、数据落点和测试方式以仓库根目录 `AGENTS.md` 为准。
- Skills/Cognition 保留轻量版本历史与回滚能力，位置：
  - `src/main/features/skills/version-store.ts`
  - `src/main/features/skills/rollback-service.ts`
- P3394 的 Wake、Experience、Candidate、Receipt、协议边界仍在 `src/main/features/p3394/` 与 group-chat bus 集成中维护。

## 验证命令

```bash
npm test
npx tsc --noEmit
./run.sh
```

如果 sqlite ABI 异常，按项目说明运行：

```bash
npm run rebuild:sqlite:electron
```
