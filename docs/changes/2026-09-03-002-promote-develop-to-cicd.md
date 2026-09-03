# 2026-09-03-002 将 develop 提升至 cicd

- 状态：`completed`
- 日期：2026-09-03
- 分支：`promotion/develop-to-cicd-20260903`
- 基线：`origin/cicd` @ `dbc2db6748b60e68e4fe8202ca66a6adb87a6d68`
- 类型：promotion work，无单独 plan

## 目标

在隔离工作树中将最新 `origin/develop` 提升到 `cicd` 的发布门禁，供远端合并审核；不触碰本地开发工作树，不直接合并到 `cicd`，不批准 0.8.0 最终 release。

## 交付内容

- 将 `origin/develop` @ `dc3898f6cde96dcccdd723d86b8b932dca542d6d` 合入最新 `origin/cicd`。
- 解决 45 处同步冲突：业务代码、测试和发布元数据以 `develop` 为准；保留 `cicd` 的 tag-source 校验、macOS/Windows 验证和 release gate。
- 保留远端 develop 已完成的安全清理、SBOM 626 组件、内置资源、运行中心和跨平台验证改动；未带入 `/Users/chenwankang/Documents/Orkas/cog-seed-home-model-drag` 的本地开发文件。
- 更新 `PROJECT_HANDOFF.md` 与本任务 change 记录，明确 PR 审核和最终 release 阻断条件。

## 验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 冲突状态 | `git diff --name-only --diff-filter=U` | passed，0 个未解决路径 |
| 类型检查 | `npm run typecheck` | passed |
| Lint | `npm run lint` | passed |
| JS 全量套件 | `npm run test:js -- --maxWorkers=2` | passed，911 个测试文件 / 10,176 个测试通过；7 个文件 / 32 个测试跳过 |
| 平台原生套件 | `npm run test:platform-native` | passed，369 个测试通过；7 个跳过 |
| Python 资源套件 | `npm run test:resources` | passed，308 个测试通过 |
| README 链接 | `npm run readme:check` | passed |
| 设计令牌 | `npm run tokens:check` | passed |
| 内置清单 | `npm run builtin:manifest:check` | passed，1288 个文件 |
| SBOM 门禁 | `npm run sbom:check` | passed，626 components in sync，CycloneDX 1.6 |
| 差异空白 | `git diff --cached --check` | warnings：97 条来自 develop 带入的 vendored YAML/runtime 与测试文件尾部空白；未修改上游导入内容 |

本机 `npm run test:resources:setup` 因包索引没有 `pytest==9.1.1` 未完成；已有资源测试仍通过。完整测试使用仓库的 Electron 入口，先运行 `npm run rebuild:sqlite:electron` 恢复 `better-sqlite3` Electron ABI；模型测试使用现有工作区的本地忽略资源，未进入 Git。

## 审核边界

- 本分支只提交到远端 promotion 分支并创建指向 `cicd` 的 PR，等待 `verify` 与 `verify-windows`；不在本任务中合并 PR。
- `trufflehog filesystem . --only-verified` 仍是 0.8.0 最终 release 的必要阻断检查，未完成前不得放行最终发版。
- `npm audit --omit=dev` 的既有 7 个生产依赖告警（4 high、2 moderate、1 low、0 critical）未由本任务引入，需在最终 release 审核中另行处置。
