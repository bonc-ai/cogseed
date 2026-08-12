# 认知树与报销工作台合并识别说明

本文用于将 `dev/niubaokang` 合并回 `origin/develop` 时识别本轮变更范围。它描述的是代码差异，不能替代代码审查、测试或发布评审。

## 比较基线与目标

| 项目 | 值 |
| --- | --- |
| 合并基线 | `origin/develop` @ `b35e19e1eeef842e9cb97827d7d2cc8ffaf2d875` |
| 功能集成提交 | `427bb2524bc2b529932e7e35205f12e15e21cedc` |
| GitLab 仓库 | `http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cogseed.git` |
| 当前远端分支 | `origin/dev/niubaokang` |
| 合并方向 | `dev/niubaokang` -> `develop` |
| 与基线差异 | 19 个提交，154 个文件，新增 21,941 行、删除 626 行 |

`develop`、`master` 和 `main` 在本轮集成推送中均未被更新；当前远端 `dev/niubaokang` 指向上述功能集成提交。本说明提交后，该分支会额外包含本文件。

## 本轮增加的能力

### 认知树

- 新增认知候选采集、证据归因、草稿和生命周期管理。认知事实在进入持久记忆前必须经过人工确认，拒绝或不完整候选不会被激活。
- 新增主进程认知 IPC、预加载白名单、渲染层认知入口与页面，以及采集提示词和中英文等界面文案。
- 将认知记录、长期记忆、反思编排和群聊派发连接到同一受控流程，维持用户作用域、日志脱敏和现有会话边界。
- 新增认知存储、候选采集、IPC、渲染控制器和跨认知/报销边界的测试覆盖。

主要路径：

```text
src/main/features/cognition/
src/main/features/cognition-memory-transaction.ts
src/main/ipc/cognition.ts
src/renderer/modules/cognition/
test/main/features/cognition/
test/main/ipc/cognition-ipc.test.ts
test/renderer/cognition-*.test.ts
```

### 报销工作台

- 新增内嵌的本地报销工作台和固定 marketplace 管理 Agent；它不启动 HTTP 服务，也不打开独立浏览器页面。
- 新增受信 Python 运行时、源码和依赖归档校验，以及用户私有可信缓存。项目目录、虚拟环境、符号链接和不受信文件不能直接成为执行输入。
- 新增能力绑定的 IPC 与预加载接口。Renderer 不可自行声明 Agent 身份、用户身份或确认能力；外部预检、提交、查询、恢复和重试都由主进程重新校验。
- 保留人工确认门：草稿、预审和报告不等同于提交或审批；飞书审批创建前需要对当前版本、哈希和目标的显式确认。遇到超时或结果不确定时先核对状态，避免重复提交。
- 新增报销领域适配、材料导入、确认/提交契约、可信组件清单、渲染层状态和 UI，以及对应的主进程、IPC、预加载和渲染测试。

主要路径：

```text
src/main/features/expense_workbench/
src/main/ipc/expense_workbench.ts
src/renderer/modules/expense-workbench*.js
resources/builtin/marketplace/agents/c045605cb916/
test/main/features/expense_workbench_*.test.ts
test/main/ipc/expense_workbench.test.ts
test/renderer/expense_workbench_*.test.ts
```

### 共同的集成与运行时变更

- 合并两个模块共用的 IPC、预加载、主进程注册、Renderer 入口、四种界面语言和样式。
- 保留运行时签名/身份隔离检查，统一源工作树运行时准备脚本和 macOS 开发打包验证。
- 增加受控 stdio 子进程、私有目录、受信 tar 解包和进程树清理工具，支撑报销组件的隔离运行。
- 增加模块边界回归测试，防止认知和报销模块互相读取对方业务数据或绕开既有权限边界。

## 合并时优先核对的共享路径

下列文件被两个功能分支或集成调整共同涉及，冲突解决时应保留本分支的安全约束和现有 `develop` 的无关后续改动：

- `scripts/prepare-source-runtime.cjs`
- `src/main/preload.js`
- `src/main/ipc/index.ts` 与 `src/main/ipc/expense_workbench.ts`
- `src/main/index.ts` 与 `src/main/features/agents.ts`
- `src/renderer/index.html`、`src/renderer/style.css`、`src/renderer/modules/agents.js`
- `src/renderer/locales/{en,zh,ja,pt}.json` 与 `src/main/locales/{en,zh,ja,pt}.json`
- `bin/runtime-gate.cjs`、`bin/ensure-runtime.cjs`、`run.sh`、`run.cmd`

合并后必须特别复核：认知长期记忆的人审门、报销外部操作的人审门、IPC allow-list、路径沙箱、受信运行时完整性校验，以及 Renderer 不可伪造报销 Agent 身份或确认能力。

## 已完成验证

功能集成提交 `427bb2524bc2b529932e7e35205f12e15e21cedc` 已完成以下验证：

- `git diff --check`
- `npm run typecheck`
- `npm test`：488 个测试文件、5,885 个测试通过；2 个文件中的 11 个测试按仓库配置跳过
- 报销 Python 资源测试：308 个通过
- `npm run package:dev:mac`
- `npm run verify:package:dev:mac`

若合并目标在这些共享路径上已有后续改动，必须在实际解决冲突后重新运行至少 `npm run typecheck` 和 `npm test`；涉及 macOS 运行时或打包脚本时，还应重新运行上述两个打包验证命令。

## 明确不包含

- 不更新或回退 `master`、`main`，也不把它们作为本轮代码来源。
- 不部署生产服务、不发布正式安装包、不自动触发飞书审批或付款。
- 不新增 HTTP 服务、端口监听或 Renderer 直连的报销 API。
- 不改变报销领域服务作为业务事实来源的边界，也不将报销业务事实复制到普通聊天或认知记忆存储。
