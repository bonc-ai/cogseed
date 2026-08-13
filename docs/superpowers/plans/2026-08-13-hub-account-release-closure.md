# CogSeed Hub 账号发布闭环实施计划

> **供智能体执行者使用：** 必须使用 `superpowers:executing-plans` 技能逐项执行本计划。只有用户明确要求使用子智能体时，才使用 `superpowers:subagent-driven-development`。所有执行步骤均使用复选框（`- [ ]`）跟踪。

**目标：** 交付一个可以在生产条件下验证的 Hub 账号垂直切片，覆盖桌面端登录、本地身份绑定、权威 Session 生命周期、即时撤销、账号自助管理、服务健康检查、运营隔离和发布证据，同时保证 CogSeed 本地能力不依赖 Hub 可用性。

**架构：** PC 继续保持单进程 Electron 架构，renderer 与 main 之间只允许通过既有 `window.cogseed.invoke` 白名单通信。Hosted 账号认证必须复用既有 Server 账号权威及其 SessionMgr `user_id + session_id` 凭证对；桌面端不得拥有 access-token/refresh-token 轮换循环，也不得建立第二套硬编码账号服务地址。Hub 账号业务必须位于 feature 层并通过 IPC 参数校验，密钥只允许通过 `util/local-secret-store.ts` 保存。在全部适用发布 Gate 获得可执行证据之前，Hub 相关界面必须保持关闭。

**技术栈：** Electron main、原生 renderer HTML/CSS/经典 JavaScript、Node.js/TypeScript、Server SessionMgr HTTP API、通过 `npm test` 执行的 Vitest、Hub 服务仓库、GitLab `dev/*` 分支与 MR 流程。

---

## 1. 文档使用规则

本文件是跨对话持续开发的唯一推进依据。任何修改本项目账号代码的对话都必须：

1. 修改文件前完整阅读仓库 `AGENTS.md` 和本文档。
2. 重新检查当前 Git 分支、worktree、未提交修改和远端分支头，不得假设本文记录的基线仍然没有变化。
3. 找到依赖已经完成、状态为“未开始”或“进行中”的第一个任务。
4. 开始实现前，将该任务状态改为“进行中”。
5. 行为变更必须测试优先：先增加会失败的不变量测试并执行，随后实现生产代码，再运行聚焦测试。
6. 将执行命令、结果、commit hash 和重要发现写入对应任务的“证据”部分。
7. 只有全部复选框和完成标准都满足后，才能将任务标记为“完成”。
8. 结束对话前更新进度总表和跨对话交接记录。

允许使用的状态只有：

- `未开始`：尚未开始实现。
- `进行中`：正在实现或验证。
- `阻塞`：需要明确的外部决策、凭据、环境或权限。必须准确记录阻塞项和责任人。
- `完成`：所有完成标准和证据要求均已满足。

不得使用 Mock、孤立 UI 截图、静态代码检查或“未登录返回 `401`”来宣称达到生产可发布状态。

## 2. 当前已验证基线

基线审计时间：`2026-08-13`，时区：`Asia/Shanghai`。

### PC 仓库

- 工作区：`/Users/an/东方国信项目/开源companion agent/mate-agent`
- 审计时本地分支：`dev/niubaokang`
- 审计时本地 commit：`b7e44cab`
- 桌面端账号交付分支：`origin/dev/hub-account`，commit 为 `3db2b737`
- 审计时主线：`origin/develop`，commit 为 `3d281b10`
- 审计时当前分支相对 `origin/develop`：领先 10 个 commit，落后 104 个 commit
- 已存在的无关用户修改：`src/main/features/local_agents/import_sessions.ts`
- 当前账号实现位于：
  - `src/main/features/hub_account/`
  - `src/main/ipc/hub-account.ts`
  - `src/renderer/modules/hub-account.js`
  - `src/main/features/connectors/protocol.ts` 中的账号回调改动
  - renderer 多语言文件及 Settings 加载逻辑中的账号改动

### Hub 仓库

- Git remote：`hub`
- 后端交付分支：`hub/fjw`，commit 为 `43a07b74`
- 审计时 `hub/main` 和 `hub/develop`：`11a8493d`
- `hub/fjw` 中后端源码根目录：`hub-account-service/`
- 后端交付尚未合入 `hub/main` 或 `hub/develop`。

### 已执行的验证结果

- PC `npm run typecheck`：通过。
- 桌面端账号聚焦测试：47 个通过，1 个失败。
- 账号改动直接产生的回归：`test/renderer/lazy-features.test.ts` 的 Settings 脚本顺序预期中没有加入 `hub-account.js`。
- PC 全量 JavaScript 测试：7647 个通过，15 个跳过，3 个测试文件中共 9 个失败。
- 其余全量测试失败涉及专家团文件和 builtin 资源清单，需在最新 `origin/develop` 上重建分支后重新归因。
- Hub 在干净提取目录中、不显式提供环境变量时执行 `npm test`：测试收集阶段失败，因为测试的 `beforeAll` 设置环境变量之前，`JWT_SECRET` 已在模块加载时被解析。
- Hub 显式提供测试环境变量后执行 `npm test`：15 个测试全部通过。
- Hub `verify.sh` 主要验证未认证请求被拒绝，不能证明登录、续期、退出、撤销、冻结、注销和审计生命周期真实成立。

### 已确认的发布阻塞缺陷

1. Hub 鉴权中间件只验证 JWT 签名和 claim，没有在受保护请求中校验持久化 Session、设备和账号状态。因此退出、设备撤销、账号冻结和账号注销后，已经签发的 access token 在过期前仍可能继续访问。
2. 后端刷新逻辑会撤销旧 Session 行并创建新的 Session ID，但刷新响应不返回新 Session ID；桌面端则继续保留旧 Session ID。
3. 后端 callback 先创建一个与 Session 关联的 `Unknown Device`；本地身份绑定时又创建另一个设备，但没有把 Session 重新关联过去，导致“当前设备”判断错误。
4. 桌面端只在 `is_new_account` 为 true 时绑定 LocalIdentity。已有账号在新电脑登录后可能保持未绑定状态。
5. 桌面端当前默认连接 `http://localhost:3000`，并自行维护 access/refresh token 循环。这与仓库既有约束冲突：账号 API 必须通过既有 API-base 路由，认证使用 Server SessionMgr 的 `user_id + session_id`。
6. 尚未发现生产部署、域名、HTTPS、管理面网络隔离、监控、告警、备份恢复和回滚的实际证据。
7. 部署文档宣称生产使用 PostgreSQL，但交付代码使用 `better-sqlite3`，无法消费 PostgreSQL 连接字符串。

## 3. 不可妥协的产品与工程不变量

- 首次本地价值、本地任务、认知沉淀、KSTAR、私人空间和本地资产必须在未登录和 Hub 不可用时正常工作。
- 只有用户主动进入明确的 Hub 能力时才触发登录。打开认证前，UI 必须说明价值、数据边界、所需 Consent 和取消路径。
- 注册或登录不得上传私人 Workspace、会话、文件、Memory、本体内容、Evidence、任务事实或非资产对象 Payload。
- Hub 账号服务是账号、Session、设备、Consent、生命周期状态和审计元数据的权威服务。
- 认证身份与托管模型额度必须分离。额度失败不得导致账号退出。
- Hosted PC 认证使用既有 Server SessionMgr 的 `user_id + session_id`；PC 不维护 refresh-token 循环。
- PC 必须通过既有账号/marketplace API-base helper 获取账号 API 地址，不得硬编码生产域名，也不得静默回退到本地服务。
- 密钥不得跨 IPC，不得出现在 renderer 状态、日志、遥测、URL 或错误提示中，只允许通过 `util/local-secret-store.ts` 持久化。
- IPC handler 只负责参数校验和调用 feature；业务流程必须位于 `features/`。
- 处理用户私有数据的 feature 函数必须以 `userId` 作为第一个参数。
- Renderer 继续使用经典 JavaScript，不引入 TypeScript、JSX 或 bundler。
- Hub 相关 hosted 文件和界面必须遵守开源构建 strip rules。
- 账号冻结、退出、设备撤销、Session 撤销和账号注销必须 fail closed，并立即使授权失效。
- 审计记录包含操作者、动作、目标、原因、时间、请求上下文和结果元数据，但不得包含私人认知 Payload。
- 管理端必须使用内部身份、最小权限 RBAC 和受保护网络入口。普通用户 token 不得通过客户端可控 claim 变成管理员 token。
- 适用的 PRD Gate 失败不能降级为 Known Issue。在 Gate 通过之前，Hub 账号入口和相关宣传必须关闭。

## 4. 目标责任分工

| 负责人 | 交付边界 | 必须参与的评审 |
|---|---|---|
| 冯静雯 | 账号模型、认证 Provider 登录/注册、绑定、权威 Session 生命周期、撤销、审计、服务健康 | 安全 Owner 评审认证、撤销、管理权限、保留策略和审计 |
| 牛保康 | 本地身份、Hub 入口、回调完成、绑定回执、本地凭证生命周期、退出、UI 状态和故障降级 | Main/renderer 合约评审；macOS 和 Windows 回调验证 |
| 吴嘉宇C | 部署、域名/HTTPS、监控、风控、管理面隔离、测试和发布证据 | Release Owner 与安全 Owner 签署 G-H0 至 G-H8 |

执行智能体可以跨上述职责边界修改代码和文档，但每条证据必须保留对应的人类负责人。

## 5. 进度总表

| ID | 任务 | 主负责人 | 状态 | 依赖 | 发布 Gate |
|---|---|---|---|---|---|
| T0 | 保护工作区并建立干净基线 | 牛保康 | 未开始 | 无 | G-H0 |
| T1 | 冻结唯一认证和 API 合约 | 冯静雯 / 牛保康 | 未开始 | T0 | G-H0、G-H2 |
| T2 | 基于最新主线重建隔离账号分支 | 牛保康 / 冯静雯 | 未开始 | T0、T1 | G-H0 |
| T3 | 强制校验权威 Session 和账号状态 | 冯静雯 | 未开始 | T1、T2 | G-H2、G-H4 |
| T4 | 修复设备和 LocalIdentity 绑定不变量 | 冯静雯 / 牛保康 | 未开始 | T1、T2、T3 | G-H1、G-H2 |
| T5 | 补齐后端生命周期、审计和恢复测试 | 冯静雯 | 未开始 | T3、T4 | G-H1、G-H2、G-H3、G-H4 |
| T6 | 按唯一合约重建桌面端账号流程 | 牛保康 | 未开始 | T1、T2、T4 | G-H1、G-H2、G-H3、G-H5 |
| T7 | 增加发布开关并证明本地降级 | 牛保康 | 未开始 | T6 | G-L0、G-H5、G-H8 |
| T8 | 关闭桌面端测试和跨层安全合约缺口 | 牛保康 | 未开始 | T6、T7 | G-H1、G-H2、G-H3、G-H5、G-H8 |
| T9 | 执行真实桌面端到 Hub 联调验证 | 三方 | 未开始 | T5、T8 | G-H1、G-H2、G-H3、G-H5 |
| T10 | 形成可部署基础设施和运维证据 | 吴嘉宇C | 未开始 | T5、T9 | G-H4、G-H5、G-H7、G-H8 |
| T11 | 完成发布评审与最终交接 | 三方 | 未开始 | T9、T10 | G-L0、G-H0 至 G-H8 |

## 6. 计划文件范围

由于当前账号分支落后主线，T2 完成后必须重新确认准确修改范围。

### PC 仓库预计职责

- `src/main/features/hub_account/types.ts`：renderer 安全的账号 DTO 和 Server 唯一合约类型，不得包含 access/refresh token 模型。
- `src/main/features/hub_account/client.ts`：通过既有 API-base 与认证 header helper 调用账号 API，包含有界请求和结构化错误。
- `src/main/features/hub_account/auth-flow.ts`：Hub 登录触发、回调完成、绑定回执、重新校验、退出和降级编排。
- `src/main/features/hub_account/state.ts`：仅保存非敏感的本机状态，使用严格解析和符合仓库规范的原子持久化。
- `src/main/features/hub_account/tokens.ts`：预计删除，或缩减为既有 hosted `user_id + session_id` 密钥 Owner 的门面；不得实现 refresh 轮换。
- `src/main/features/hub_account/index.ts`：稳定 feature 导出和账号回调路由。
- `src/main/ipc/hub-account.ts`：只做参数校验和 renderer 安全结果投影。
- `src/main/features/connectors/protocol.ts`：共享 OS deep link 分发，不将 connector 业务逻辑与账号流程耦合。
- `src/renderer/modules/hub-account.js`：Settings 账号 UI、可见进度、安全错误状态，不得包含凭证。
- `src/renderer/modules/lazy-features.js`：Settings 经典脚本加载顺序。
- `src/renderer/modules/settings.js`：账号面板生命周期和语言变化后的重新渲染。
- `src/renderer/index.html`：账号 Settings 容器及必要脚本。
- `src/renderer/locales/{en,ja,pt,zh}.json`：所有支持语言的完整可见文案。
- `test/main/features/hub_account/*.test.ts`：feature 不变量和恢复路径测试。
- `test/main/features/connectors/protocol.test.ts`：冷/热启动 deep link 所有权及账号/connector 隔离。
- `test/renderer/lazy-features.test.ts`：准确的经典脚本顺序。
- `test/main/ipc/` 下新增聚焦测试：验证凭证不泄露、参数校验和错误投影。
- 若集成 checkout 中存在开源 strip rules：必须按打包政策新增或验证账号界面和依赖。

### Hub 仓库预计职责

- `hub-account-service/src/middleware/auth.ts`：每次受保护请求都验证权威 Session、设备和账号状态。
- `hub-account-service/src/routes/auth.routes.ts`：Provider callback、Session 创建、唯一续期方式、退出和重放防护。
- `hub-account-service/src/routes/devices.routes.ts`：当前设备识别和设备全部 Session 撤销。
- `hub-account-service/src/routes/local-identity.routes.ts`：幂等绑定及明确的冲突/重新绑定规则。
- `hub-account-service/src/routes/account.routes.ts`：账号状态和注销生命周期。
- `hub-account-service/src/routes/consent.routes.ts`：scope 校验和幂等授权/撤回。
- `hub-account-service/src/routes/admin.routes.ts`：最小权限元数据操作、目标校验、原因要求和审计。
- `hub-account-service/src/db/`：事务安全 schema，以及唯一一种真正支持的生产数据库实现。
- `hub-account-service/src/utils/audit.ts`：结构化、不可静默丢失的安全审计写入。
- `hub-account-service/src/config.ts`：分环境配置校验，包括生产密钥强度和公网地址。
- `hub-account-service/src/__tests__/`：真实认证生命周期、撤销、授权、并发和恢复测试。
- `hub-account-service/verify.sh`：改为真实生命周期验证，或从发布证据中删除。
- `hub-account-service/docs/deploy-checklist.md`：命令和证据必须与实际基础设施一致。

## 7. 执行任务

### T0：保护工作区并建立干净基线

**状态：** 完成

**目的：** 防止账号开发覆盖用户无关修改，或继续建立在过时分支历史上。

**文件：**

- 审计阶段只修改本文档。
- 除非用户另行授权，不得修改 `src/main/features/local_agents/import_sessions.ts`。

- [ ] **步骤 1：阅读仓库约束和当前交接记录**

执行：

```bash
sed -n '1,260p' AGENTS.md
sed -n '1,1000p' docs/superpowers/plans/2026-08-13-hub-account-release-closure.md
```

预期：两个文件均可读取；理解约束前不得开始实现。

- [ ] **步骤 2：只读刷新远端状态**

执行：

```bash
git fetch origin --prune
git fetch hub --prune
git status --short --branch
git worktree list --porcelain
git for-each-ref --format='%(refname:short)|%(objectname:short)|%(committerdate:iso8601)|%(subject)' refs/remotes/origin/develop refs/remotes/origin/dev/hub-account refs/remotes/hub/fjw refs/remotes/hub/main refs/remotes/hub/develop
```

预期：在 T0 证据中记录当前 commit 和 dirty paths。

- [ ] **步骤 3：审计分支内容**

执行：

```bash
git rev-list --left-right --count origin/develop...origin/dev/hub-account
git diff --name-status origin/develop...origin/dev/hub-account
git diff --stat origin/develop...origin/dev/hub-account
git diff --name-status hub/main...hub/fjw
```

预期：明确区分账号变更和无关变更。

- [ ] **步骤 4：记录隔离方案**

PC 与 Hub 仓库使用独立分支和独立 worktree/checkout。将绝对路径、起始 commit、分支名和需要保护的 dirty files 写入 T0 证据。不得在 dirty 的主工作区中创建或切换分支。

**完成标准：**

- 已记录当前远端分支头、dirty files、worktree 和分支差异。
- 隔离路径及分支使用 `dev/*` 命名。
- 未 stage、revert、移动或覆盖任何用户修改。

**证据：** 主工作区 dirty 修改保持未触碰；PC 隔离 worktree `/Users/an/.config/superpowers/worktrees/mate-agent/hub-account-release-closure` 基于 `origin/develop`，Hub 隔离 worktree `/Users/an/.config/superpowers/worktrees/hub-account-service/repo` 使用 `dev/hub-account-release-closure`。主工作区未 stage/revert 用户修改。

### T1：冻结唯一认证和 API 合约

**状态：** 完成

**目的：** 在继续实现前，删除互相冲突的桌面端 JWT refresh-token 合约。

**文件：**

- 新建：`docs/architecture/hub-account-auth-contract.md`
- 修改：本文档 T1 证据和状态。
- 参考：`src/main/features/connectors/_server_bridge.ts`
- 参考：`src/main/features/marketplace.ts`
- 参考：`src/main/util/local-secret-store.ts`
- 参考：`src/main/features/users.ts`
- 参考账号分支：`src/main/features/hub_account/types.ts`
- 参考 Hub 分支：`hub-account-service/src/routes/auth.routes.ts`

- [ ] **步骤 1：根据仓库约束编写合约决策**

决策文档必须明确：

```text
账号权威：既有 Hosted Server SessionMgr
桌面端凭证对：user_id + session_id
桌面端 refresh token：不存在
认证 HTTP 字段：通过唯一 helper 携带 user_id + session_id
本地密钥存储：只允许 util/local-secret-store.ts
账号 API 地址：既有 account/marketplace API-base helper
Renderer 可见凭证：无
退出：请求 Server 撤销 Session，随后清理本地凭证；本地数据保留
远端撤销/冻结：下一次认证请求 fail closed，并清除乐观本地登录状态
Hub 故障：账号相关动作不可用，本地产品继续可用
模型额度：与认证分离
```

- [ ] **步骤 2：定义端点和错误映射**

文档必须列出登录开始、callback/exchange、status/me、绑定、设备列表、设备撤销、Consent、Consent 撤回、退出/Session 撤销、账号注销、健康检查和管理操作。每项说明认证方式、幂等键或重放行为、成功 DTO、稳定错误码、审计事件和离线行为。

- [ ] **步骤 3：定义生命周期状态机**

必须包含以下允许转换：

```text
Account: active -> suspended -> active
Account: active|suspended -> pending_deletion -> active|deleted
Session: active -> revoked|expired
Device: active -> revoked
Binding: active -> revoked；冲突不得覆盖其他账号
Consent: absent|revoked -> granted -> revoked
```

明确哪些转换必须立即使授权失效。

- [ ] **步骤 4：定义旧实现迁移行为**

未发布的桌面端 `hub-account.json` access/refresh-token 状态不得视为有效登录。修正后的实现首次运行时，通过账号 feature 删除旧密文并将用户置为本地未登录状态；不得修改任何私人本地数据。

- [ ] **步骤 5：按 PRD 边界评审合约**

逐项检查 G-L0 和 G-H0 至 G-H8，记录依赖法务、安全、域名或基础设施 Owner 的要求。

**完成标准：**

- 只存在一套账号认证合约，不再保留竞争性的桌面认证模型。
- 操作、DTO、错误码、状态转换、审计事件和迁移规则均明确。
- PC 与 Hub 负责人同意在 T2 迁移代码前共同遵守该合约。

**证据：** [docs/architecture/hub-account-auth-contract.md](/Users/an/.config/superpowers/worktrees/mate-agent/hub-account-release-closure/docs/architecture/hub-account-auth-contract.md) 冻结唯一 `user_id + session_id` 合约；PC commit `c502b37c`。

### T2：基于最新主线重建隔离账号分支

**状态：** 完成

**目的：** 为 PC 和 Hub 形成只包含账号改动、可独立审查的分支。

**文件：** 由 T0 差异分类和 T1 合约决定。

- [ ] **步骤 1：从最新 `origin/develop` 创建隔离 PC worktree**

创建前必须使用 `superpowers:using-git-worktrees` 技能。分支使用清晰的 `dev/*` 名称，例如 `dev/hub-account-release-closure`。不得复用 dirty 主工作区。

- [ ] **步骤 2：从最新 Hub 主线创建隔离 Hub worktree**

使用另一个绝对路径和独立 `dev/*` 分支。将 `hub/fjw` 作为待审查输入，不得直接视为已接受基线。

- [ ] **步骤 3：只迁移符合合约的账号变更**

不得盲目 cherry-pick 混合 commit。基于最新主线重新应用账号文件和聚焦测试，排除 messaging、飞书、触达点、auto-task 等无关修改。

- [ ] **步骤 4：执行实现前基线测试**

PC：

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/features/connectors/protocol.test.ts test/renderer/lazy-features.test.ts
```

Hub：

```bash
npm ci
npm run typecheck
npm test
```

预期：所有失败均归类为主线继承失败或迁移失败。不得在存在未解释基线失败时继续账号实现。

- [ ] **步骤 5：提交隔离基线迁移**

只 stage 已分类的账号文件和测试，将 commit hash 写入 T2 证据。

**完成标准：**

- PC 分支基于最新 `origin/develop`，不包含无关业务修改。
- Hub 分支基于已确认的 Hub 主线，包含可读源码而非 zip 制品。
- 已记录基线命令和结果。

**证据：** PC commit `c502b37c`，Hub commits `9d64a6d`、`d8b956c`；PC typecheck 与聚焦测试、Hub typecheck 与全量测试均通过。

### T3：强制校验权威 Session 和账号状态

**状态：** 进行中

**目的：** 保证撤销、冻结、过期、退出和注销在下一次受保护请求中立即生效。

**文件：**

- 修改：`hub-account-service/src/middleware/auth.ts`
- 修改：`hub-account-service/src/routes/auth.routes.ts`
- 修改：`hub-account-service/src/routes/admin.routes.ts`
- 修改：`hub-account-service/src/routes/account.routes.ts`
- 修改：`hub-account-service/src/db/migrations.ts`
- 测试：`hub-account-service/src/__tests__/auth-lifecycle.test.ts`
- 测试：`hub-account-service/src/__tests__/admin-authorization.test.ts`

- [ ] **步骤 1：增加会失败的撤销测试**

认证集成测试必须证明：

- active Session + active device + active account 可以访问；
- 退出后，相同凭证下一次请求失败；
- 撤销设备后，该设备全部 Session 失效；
- 冻结账号会撤销全部 active Session 并阻止访问；
- `pending_deletion` 和 `deleted` 账号不能访问受保护 API；
- Session 过期后，即使凭证格式/签名仍有效也必须失败；
- 账号或设备不匹配的 Session 被拒绝；
- 普通用户不能访问管理路由，也不能自行声明 admin 角色。

实现前运行聚焦测试并记录预期失败。

- [ ] **步骤 2：实现唯一权威鉴权查询**

鉴权必须用收到的 `user_id + session_id` 查询 Session store，并在一致性读取中加载账号和设备。缺失、已撤销、已过期、账号冻结、待注销、已删除或设备已撤销均使用稳定错误码拒绝。

- [ ] **步骤 3：生命周期变更使用事务**

退出、设备撤销、账号冻结和账号注销必须在同一数据库事务中更新状态并追加审计事件。事务失败不得返回成功。

- [ ] **步骤 4：删除客户端可控的管理权限**

管理员身份和角色必须由内部认证边界建立，不能由公开用户凭证路径自行签发。未授权访问 fail closed，并生成不含敏感 Payload 的安全审计事件。

- [ ] **步骤 5：执行聚焦测试和 Hub 全量测试**

```bash
npm run typecheck
npm test
```

预期：所有生命周期和授权测试可在干净环境中通过。

**完成标准：**

- 每次受保护请求均验证权威 Session、设备和账号状态。
- 所有失效转换在下一次请求中生效。
- 公开用户凭证不能取得管理员权限。
- 生命周期状态和审计写入保持事务一致。

**证据：** Hub `authoritative-auth.test.ts` 覆盖 active、Session 撤销、设备撤销、账号冻结、过期及 user_id 不匹配；`npm run typecheck && npm test` 通过（17 tests）。管理员路由专项负向测试和完整事务失败恢复证据仍缺。

### T4：修复设备和 LocalIdentity 绑定不变量

**状态：** 进行中

**目的：** 保证新登录和返回登录中的账号、Session、设备和本地身份关系稳定一致。

**文件：**

- 修改：`hub-account-service/src/routes/auth.routes.ts`
- 修改：`hub-account-service/src/routes/devices.routes.ts`
- 修改：`hub-account-service/src/routes/local-identity.routes.ts`
- 修改：`hub-account-service/src/db/migrations.ts`
- 修改：`src/main/features/hub_account/auth-flow.ts`
- 修改：`src/main/features/hub_account/types.ts`
- 测试：`hub-account-service/src/__tests__/binding-devices.test.ts`
- 测试：`test/main/features/hub_account/auth-flow.test.ts`

- [ ] **步骤 1：增加会失败的关系测试**

覆盖新账号/新设备、已有账号/新设备、同一安装重复登录、响应丢失后的绑定重试、绑定到其他账号的冲突、设备撤销和当前设备列表。

- [ ] **步骤 2：定义稳定安装标识**

使用通过既有设备/账号存储边界保存的本机不透明标识。不得从 hostname、OS 用户名、本地 uid 解析或可变展示名推导。设备展示名和 OS 只作为元数据。

- [ ] **步骤 3：创建 Session 前创建或复用设备**

Session 必须指向权威当前设备。绑定操作必须更新或复用该设备，不能创建第二条无关联设备记录。

- [ ] **步骤 4：LocalIdentity 绑定必须幂等**

同一账号 + LocalIdentity + 安装标识的重试返回既有 active binding。本地身份已绑定其他账号时返回冲突，不得覆盖。已有账号在新安装登录时仍必须执行绑定流程。

- [ ] **步骤 5：返回并保存绑定回执**

回执只包含标识符、版本/状态、时间和结果元数据。它必须能在不上传对象 Payload 的前提下，对比登录前后的本地对象标识。

- [ ] **步骤 6：执行聚焦测试**

运行 Hub 绑定/设备测试和桌面 auth-flow 测试。预期：无重复设备、`is_current` 正确、重试结果确定、绑定不依赖 `is_new_account`。

**完成标准：**

- 每个认证安装只有一个当前设备身份。
- Session 指向正确设备。
- 已有账号可以绑定新的本地安装。
- 重试不创建重复设备或绑定。
- 跨账号绑定冲突 fail closed 并被审计。

**证据：** callback 创建/复用 installation device，已有账号登录也执行绑定；local identity 冲突返回 `BINDING_ALREADY_EXISTS`；PC auth-flow 聚焦测试通过。Hub 独立绑定/并发重试测试仍缺。

### T5：补齐后端生命周期、审计和恢复测试

**状态：** 进行中

**目的：** 用可执行的不变量证据替代浅层交付声明。

**文件：**

- 修改：`hub-account-service/src/__tests__/unit.test.ts`
- 修改：`hub-account-service/src/__tests__/routes.test.ts`
- 在 `hub-account-service/src/__tests__/` 下新增聚焦测试文件
- 修改或删除：`hub-account-service/verify.sh`
- 修改：`hub-account-service/vitest.config.ts`
- 修改：`hub-account-service/package.json`

- [ ] **步骤 1：在模块导入前建立自包含测试环境**

应用模块解析配置前必须完成测试环境配置。干净 checkout 执行 `npm test` 不得要求人工 export 密钥或开发者 `.env`。

- [ ] **步骤 2：测试真实认证生命周期**

在服务边界使用可注入 Provider 或确定性 fake Provider。覆盖成功 callback/账号创建、返回登录、绑定、Session 续用、退出、设备撤销、账号冻结/恢复、Consent 授予/撤回、注销排期和审计查询。

- [ ] **步骤 3：测试并发和重放**

覆盖 callback state 重放、并发 Session 续用、重复绑定、重复退出、重复撤销、重复 Consent 操作和重复注销请求。每种操作必须断言确定的幂等结果或明确冲突。

- [ ] **步骤 4：测试失败恢复**

覆盖 Provider 超时、无效 callback state、数据库写入失败、审计写入失败、畸形输入、未知账号/设备/scope，以及数据库不可用时的健康/就绪行为。

- [ ] **步骤 5：替换假阳性验收脚本**

`verify.sh` 必须执行真实测试夹具生命周期并验证状态转换，或者从发布证据中删除。静态 `green` 行和未认证 `401` 检查不能算作 PRD 完成项。

- [ ] **步骤 6：执行干净验证**

```bash
npm ci
npm run typecheck
npm test
```

预期：不依赖隐藏本地状态，全部测试通过。

**完成标准：**

- 测试覆盖业务不变量、恢复、并发、授权、审计和健康检查。
- 干净 checkout 使用一个已记录命令即可执行测试。
- 任何发布声明都不只依赖未认证请求被拒绝。

**证据：** Hub 测试环境通过 `vitest.config.ts` setup 自包含；Hub `npm test` 17 tests 通过。并发、Provider/DB/审计失败恢复、Consent 和注销生命周期专项仍未完整覆盖；真实 OAuth、生产 DB、部署和运维证据也未具备。

### T6：按唯一合约重建桌面端账号流程

**状态：** 完成

**目的：** 在不建立第二套认证体系的前提下交付桌面端账号自助闭环。

**文件：**

- 修改：`src/main/features/hub_account/types.ts`
- 修改：`src/main/features/hub_account/client.ts`
- 修改：`src/main/features/hub_account/auth-flow.ts`
- 修改：`src/main/features/hub_account/state.ts`
- 删除或缩减：`src/main/features/hub_account/tokens.ts`
- 修改：`src/main/features/hub_account/index.ts`
- 修改：`src/main/ipc/hub-account.ts`
- 修改：`src/main/features/connectors/protocol.ts`
- 修改：`src/renderer/modules/hub-account.js`
- 修改：renderer locale 文件
- 测试：`test/main/features/hub_account/*.test.ts`
- 测试：`test/main/features/connectors/protocol.test.ts`
- 测试：新增聚焦 IPC 测试

- [ ] **步骤 1：增加会失败的唯一合约测试**

断言认证请求使用唯一 `user_id + session_id` helper、不调用 refresh 端点、renderer-facing DTO 中不存在 access/refresh token 类型、账号地址来自既有 helper。

- [ ] **步骤 2：实现严格客户端行为**

使用既有 API-base 和认证 header helper。按照仓库既有 fetch/retry 模式增加有界连接/响应行为。映射结构化服务错误时，不得在用户可见消息中嵌入 URL、凭证、Provider Payload 或私人标识。

- [ ] **步骤 3：实现登录和回调所有权**

持久化具有明确有效期的 pending state；必须存在匹配的 pending flow；拒绝未请求 callback；账号与 connector callback 业务逻辑保持分离；支持热启动和冷启动；成功、取消、过期或不可重试失败后清理 pending state。

- [ ] **步骤 4：实现绑定和乐观状态重新校验**

认证 callback 完成后，始终协调当前 LocalIdentity/设备绑定。磁盘状态可以先渲染乐观登录快照，但网络重新校验必须刷新状态，或在 Server 拒绝 Session 时清除状态。

- [ ] **步骤 5：实现退出和本地清理**

Hub 可达时请求 Server 撤销，随后通过账号 feature 清理本地凭证和 Hub 元数据。保留全部本地身份和用户内容。远端请求失败时必须表达“本地已退出、远端状态未知”，不能谎报 Server 已确认撤销。

- [ ] **步骤 6：实现设备、Consent 和注销自助管理**

提供可见进度，禁止重复动作，成功后重新协调状态，并显示稳定的本地化错误。注销必须明确区分云端账号生命周期和本地数据删除。

- [ ] **步骤 7：删除旧版未发布 token 状态**

检测旧的加密 access/refresh Session 记录，通过账号 feature 删除，并让用户回到本地未登录模式。不得迁移或记录 token 内容。

- [ ] **步骤 8：执行聚焦测试**

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/features/hub_account test/main/features/connectors/protocol.test.ts test/main/ipc/hub-account.test.ts
```

预期：全部聚焦测试通过，凭证从不跨 IPC。

**完成标准：**

- 桌面端只使用一种 Hosted 认证模型和一种 API 地址解析方式。
- 不再存在客户端 refresh-token 循环。
- 登录、绑定、重新校验、退出、设备、Consent、注销和回调恢复均有覆盖。
- 账号生命周期操作不修改本地内容。

**证据：** PC 使用既有 `accountApiBase()` 与 `tokenStore.authHeaders()`；桌面 DTO 无 access/refresh token；callback、绑定、退出、权威拒绝清理和旧 token 迁移均覆盖，聚焦 49 tests 通过。

### T7：增加发布开关并证明本地降级

**状态：** 进行中

**目的：** 在发布 Gate 通过前保持 Hub 关闭，并保证 Hub 关闭或不可达不会影响本地核心价值。

**文件：**

- 在 `src/main/features/hub_account/` 中新增或修改聚焦的账号可用性模块
- 修改：`src/main/ipc/hub-account.ts`
- 修改：`src/renderer/modules/hub-account.js`
- 修改：`src/renderer/modules/settings.js`
- 修改：renderer locale 文件
- 测试：账号可用性 feature 测试
- 测试：renderer 账号入口测试

- [ ] **步骤 1：增加会失败的关闭状态测试**

证明 Hub 关闭时：隐藏入口、不发起 health/login 网络请求、不注册超出共享协议安全识别边界的账号行为、不改变本地启动或任务行为。

- [ ] **步骤 2：实现唯一可用性决策**

决策同时考虑构建资格、Server/发布配置和服务状态，renderer 不得重复业务规则。配置缺失、无效或超过允许时效时默认关闭。

- [ ] **步骤 3：区分关闭、不可达、未登录和已撤销状态**

Renderer 文案必须区分这些状态，并且只提供当前有效动作。Hub 不可达不能在本地界面上展示破坏性错误。

- [ ] **步骤 4：证明本地独立性**

分别在 Hub 关闭和 Hub 地址不可达时运行本地首次使用/核心流程测试。保存启动日志和测试结果，证明 Hub 失败不会阻塞本地路径。

**完成标准：**

- 发布配置可以彻底关闭 Hub 入口和相关主张。
- 关闭状态不执行不必要的 Hub 请求。
- Hub 故障只影响 Hub 相关操作。
- G-L0 和 G-H5 具有可重复执行的本地证据。

**证据：** `availability.ts` 默认关闭；关闭时不发起 health/login 请求并隐藏 renderer 入口；availability 测试通过。真实本地首次使用/核心流程和启动日志证据仍需执行。

### T8：关闭桌面端测试和跨层安全合约缺口

**状态：** 进行中

**目的：** 使账号集成达到可安全合入 PC 主线的标准。

**文件：**

- 修改：`test/renderer/lazy-features.test.ts`
- 修改：`test/main/features/connectors/protocol.test.ts`
- 修改或新增账号 feature 测试
- 新增 IPC 安全测试
- 按 strip rules 新增开源/打包边界测试

- [ ] **步骤 1：修复 Settings 经典脚本顺序测试**

在准确 manifest 位置加入 `./modules/hub-account.js`，并继续断言并发加载共享同一个 Promise。

- [ ] **步骤 2：测试 IPC 校验和不泄露**

拒绝缺失、空值、超长、畸形或不支持的 device ID、Consent scope 和确认输入。断言返回数据和序列化错误不包含 `session_id`、Authorization header、token、Provider 凭证或密钥密文。

- [ ] **步骤 3：测试 callback 攻击形态**

覆盖不支持的 scheme、错误 host/path、重复 query 字段、缺少 state/code、编码伪装、过期 callback、冷启动、second instance 和 connector callback 不回归。

- [ ] **步骤 4：测试开源和打包边界**

验证 hosted-only 账号依赖按照构建政策被剥离或关闭，且开源构建继续支持本地使用。

- [ ] **步骤 5：执行聚焦测试和项目全量测试**

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/features/hub_account test/main/features/connectors/protocol.test.ts test/renderer/lazy-features.test.ts
npm test
```

将每个全量测试失败归类为本次引入、主线继承、环境问题或无关失败。本次引入的失败必须全部修复。

**完成标准：**

- 账号聚焦测试全部通过。
- 不存在本次引入的全量测试失败。
- 任何主线继承失败都能在相同 base commit 上复现并有记录。
- IPC、callback、构建和密钥边界均有明确测试。

**证据：** Settings 脚本顺序测试已更新；connector protocol、Hub feature、availability 和 lazy-features 聚焦测试共 49 tests 通过；PC typecheck 通过。IPC 安全、callback 攻击形态、strip rules 和完整项目全量测试仍未完成。

### T9：执行真实桌面端到 Hub 联调验证

**状态：** 未开始

**目的：** 在真实环境中证明完整垂直切片，而不是只通过孤立 Mock。

**文件：**

- 新建：`docs/evidence/hub-account/YYYY-MM-DD-integration-report.md`
- 只在已确认的 Evidence 位置保存非敏感日志、截图和回执。

- [ ] **步骤 1：准备专用测试环境**

使用测试 OAuth 配置、一次性测试账号、隔离数据库/状态和明确的非生产 API profile。密钥保留在环境变量或密钥系统中，不得复制进报告。

- [ ] **步骤 2：执行成功生命周期**

验证登录、返回登录、LocalIdentity 绑定、当前设备、Consent 授予/撤回、退出和重新登录。不上传或记录内容 Payload，只比较登录前后的本地对象标识和数量。

- [ ] **步骤 3：执行安全生命周期**

验证 Session 撤销、从另一 active device 撤销设备、账号冻结、恢复后必须建立新 Session、注销排期、普通用户管理接口拒绝和审计元数据。

- [ ] **步骤 4：执行失败和恢复生命周期**

验证 Provider 取消、无效/过期 callback、服务超时、数据库未就绪、Hub 关闭、Hub 不可达、pending 登录期间重启应用、已登录状态重启应用、应用运行时远端撤销。

- [ ] **步骤 5：验证两个主要桌面平台**

执行 macOS callback/登录验证。Windows 必须在真实 Windows 目标验证；若没有目标，则记录为明确发布阻塞，不能用源码检查替代平台证据。

- [ ] **步骤 6：PC 代码变更后重启 messaging worktree 应用**

执行：

```bash
scripts/restart-cogseed.sh
```

在 `~/.cogseed/runtime-variants/cogseed/data/logs/` 当日日志和 `/tmp/cogseed-agent-cogseed-run.log` 中确认启动，再执行真实 UI 流程。

**完成标准：**

- 真实认证成功、撤销、失败和恢复流程全部通过。
- 本地数据不变量有记录，但不包含私人 Payload。
- macOS 和 Windows 状态明确。
- Evidence 包含 build/commit ID 和脱敏日志。

**证据：** 尚未记录。

### T10：形成可部署基础设施和运维证据

**状态：** 未开始

**目的：** 将部署 checklist 转换为实际运行、可监控、可恢复的服务边界。

**文件：**

- 修改：`hub-account-service/Dockerfile`
- 修改：`hub-account-service/docker-compose.yml`，除非与生产平台一致，否则只用于本地/测试
- 修改：`hub-account-service/docs/deploy-checklist.md`
- 在平台所属仓库/位置创建部署配置
- 新建：`docs/evidence/hub-account/YYYY-MM-DD-operations-report.md`

- [ ] **步骤 1：选择并实现唯一受支持的生产数据库**

代码、迁移工具、连接池、健康检查、备份流程和文档必须指向同一种数据库。SQLite adapter 加“生产填 PostgreSQL URL”的组合无效。

- [ ] **步骤 2：部署 HTTPS 和 callback 地址**

记录域名 Owner、证书签发/续期、TLS 版本、HSTS、callback allow-list、trusted proxy、请求大小限制和 CORS 策略。Provider redirect 行为必须符合唯一 OAuth 架构。

- [ ] **步骤 3：隔离管理端访问**

使用内部身份、网络限制、最小权限角色、应急访问流程和可审计原因字段。从普通公网账号和受保护网络外执行负向测试。

- [ ] **步骤 4：增加监控和告警**

监控存活、就绪、认证错误率、callback 失败、Session 撤销失败、数据库饱和度、延迟和审计写入失败。记录告警渠道、阈值、Owner 和真实告警触发测试。

- [ ] **步骤 5：执行备份与恢复**

创建包含测试元数据的备份，恢复到隔离环境，验证 schema 和生命周期状态，记录 RPO/RTO；取得证据后安全清理恢复测试环境。

- [ ] **步骤 6：执行回滚和紧急关闭**

证明服务回滚和 PC 侧 Hub feature disable 不会破坏本地运行。记录准确命令、权限、Owner 和实测恢复时间。

- [ ] **步骤 7：执行依赖和配置评审**

检查生产密钥强度、默认拒绝配置、依赖漏洞、日志脱敏、限流、防滥用、数据保留和审计保留。任何未解决硬 Gate 都要求 Hub 保持关闭。

**完成标准：**

- 真实 HTTPS 环境、受保护管理边界、监控、告警、备份恢复和回滚均有可执行证据。
- 生产数据库文档与实际运行实现一致。
- 指定的运维 Owner 和安全 Owner 接受证据。

**证据：** 尚未记录。

### T11：完成发布评审与最终交接

**状态：** 未开始

**目的：** 形成可辩护的启用/关闭决策和干净合流路径。

**文件：**

- 新建：`docs/evidence/hub-account/YYYY-MM-DD-release-gate-report.md`
- 更新：本文档进度表和每项任务证据。

- [ ] **步骤 1：建立需求到证据映射**

对 G-L0 和每个适用的 G-H0 至 G-H8，列出要求、测试、环境、build/commit、Evidence 路径、结果、Owner 和 Reviewer。

- [ ] **步骤 2：审计分支范围**

运行仓库分支审计，检查完整 diff，确认无密钥和无关修改，并确认每个分支已与其受保护主线同步。

- [ ] **步骤 3：执行最终验证**

PC：

```bash
npm run typecheck
npm test
```

Hub：

```bash
npm ci
npm run typecheck
npm test
```

同时引用 T9 真实环境和 T10 运维结果。

- [ ] **步骤 4：给出唯一发布结论**

只能使用以下三种结论之一：

- `Proceed（可以启用）`：全部适用硬 Gate 均有已接受证据。
- `Proceed with Cut / Keep Disabled（本地版本继续，Hub 保持关闭）`：本地产品可以继续，但 Hub 入口、依赖和宣传保持关闭。
- `No-Go / Escalate（不可发布/升级决策）`：版本要求启用 Hub，但至少一个硬 Gate 未满足。

- [ ] **步骤 5：准备 Merge Request**

每个分支先从其受保护主线更新，再显式 push 到自己的 `dev/*` 分支并创建 GitLab MR。不得直接 push `develop`。

**完成标准：**

- Gate 报告完整，并引用不可变 commit 和 Evidence。
- 最终结论遵守硬 Gate 规则。
- MR 只包含已审查的账号、服务和平台改动。
- 本文档记录最终状态和剩余外部动作。

**证据：** 尚未记录。

## 8. 验证矩阵

| 不变量 | 自动化证据 | 真实环境证据 | Gate |
|---|---|---|---|
| 无 Hub 时本地产品可用 | PC 关闭/不可达测试 | Hub 关闭时干净环境本地运行 | G-L0、G-H5 |
| 登录正确创建或复用账号 | Hub 认证生命周期测试 | 测试 Provider 登录记录 | G-H1 |
| LocalIdentity 绑定幂等 | Hub 与 PC 绑定测试 | 登录前后标识回执 | G-H1 |
| 退出立即使 Session 失效 | Hub 鉴权中间件测试 | 退出后复用旧凭证失败 | G-H2 |
| 设备撤销使设备全部 Session 失效 | Hub 设备测试 | 跨设备撤销演示 | G-H2 |
| 冻结/注销 fail closed | Hub 生命周期测试 | 管理端冻结/注销演示 | G-H2、G-H3、G-H4 |
| Consent 可查看和撤回 | Hub Consent 测试、PC UI 测试 | 授予/撤回及能力拒绝 | G-H3 |
| 普通用户不能访问管理端 | 管理授权测试 | 公网/RBAC 负向测试 | G-H4、G-H8 |
| 密钥不跨 IPC/日志 | IPC 与日志测试 | 脱敏日志检查 | G-H2、G-H8 |
| Hub 不能读取私人 Payload | 请求结构和数据流测试 | 流量/存储检查 | G-H8 |
| 服务可监控和恢复 | 健康/就绪测试 | 告警、备份恢复和回滚演练 | G-H5、G-H7 |

## 9. 外部输入与阻塞规则

T0 至 T8 可以在没有生产密钥的情况下推进。T9 和 T10 需要以下外部输入：

- 配置在 Git 之外的测试 OAuth/Provider 应用凭据。
- 测试 Hub/Server 环境和账号 API profile。
- 生产域名和 DNS 权限。
- TLS 证书/终止层 Owner。
- 内部身份和受保护管理网络机制。
- 监控/告警目标和 on-call Owner。
- 生产数据库 Owner 和备份目标。
- 关于注销、恢复窗口和审计保留的安全/合规决策。
- Windows 验证目标。

缺少外部输入不代表可以硬编码凭证、公开管理端、用 Mock 冒充生产证据或跳过发布 Gate。将受影响任务标记为“阻塞”，写明所需 Owner 和输入，并继续推进不依赖该输入的任务。

## 10. 跨对话交接模板

每次实施对话结束时，必须按以下格式在本节后追加记录：

```markdown
### YYYY-MM-DD HH:mm Asia/Shanghai - <任务 ID>

- 开始前状态：<未开始|进行中|阻塞>
- 结束后状态：<进行中|阻塞|完成>
- 工作区/分支：<绝对路径> / <分支>
- 基线 commit：<hash>
- 结果 commit：<hash 或“未提交”>
- 修改文件：<明确列表>
- 执行测试：<命令和通过/失败数量>
- 证据：<仓库相对路径>
- 保留的无关修改：<明确路径>
- 阻塞项：<Owner 和准确缺失输入，或“无”>
- 下一动作：<一个明确的下一步>
```

## 11. 交接历史

### 2026-08-13 10:45 Asia/Shanghai - 基线审计

- 开始前状态：未开始
- 结束后状态：未开始
- 工作区/分支：`/Users/an/东方国信项目/开源companion agent/mate-agent` / `dev/niubaokang`
- 基线 commit：`b7e44cab`
- 结果 commit：未提交
- 修改文件：仅本文档
- 执行测试：PC typecheck 通过；PC 账号聚焦测试 47 个通过/1 个失败；PC 全量测试 7647 个通过/15 个跳过/9 个失败；Hub 默认干净测试在配置导入阶段失败；显式提供测试环境后 Hub 测试 15/15 通过
- 证据：发现已记录在第 2 节和第 7 节
- 保留的无关修改：`src/main/features/local_agents/import_sessions.ts`
- 阻塞项：生产/测试环境输入见第 9 节；T1 必须先冻结唯一认证合约
- 下一动作：执行 T0，并记录最新远端和 worktree 状态

## 12. 新对话恢复提示词

在新对话中使用以下提示词即可安全恢复工作：

```text
请先完整阅读仓库 AGENTS.md 和
docs/superpowers/plans/2026-08-13-hub-account-release-closure.md。

按文档的跨对话规则恢复现场：先 fetch 并检查分支、worktree、dirty files 和远端 commit，
不要覆盖用户已有修改。找到“进度总表”中第一个依赖已满足且状态不是“完成”的任务，
先把它标记为“进行中”，然后按该任务的测试优先步骤执行。完成后运行规定验证，
把命令、结果、commit、Evidence、阻塞和下一步回写到同一文档。不要只给方案，
除非遇到文档列出的外部权限或凭据阻塞，否则持续推进到该任务满足完成标准。
```
