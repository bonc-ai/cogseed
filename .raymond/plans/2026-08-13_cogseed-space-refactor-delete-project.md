# CogSeed 空间化重构（删法 B）实施计划

> **For Hermes:** 用 subagent-driven-development 逐任务执行，或用 progress-driven-cron-execution 按 PROGRESS.md tick。本文件即自包含提示词，新会话无上下文也可执行。

**目标：** 彻底废弃「项目」层，会话直接挂空间，界面主打空间，空间内展示任务/产物/资产三类内容。

**已拍板的 4 个决策：**
1. orphan 会话（无 space_id）不算任何空间，空间列表不纳入。
2. 资产走路线 A：资产全局唯一，空间通过 `asset_reference_bindings` 引用，不复制所有权。
3. 删法 B：彻底重构，`conversation.project_id` → `conversation.space_id`，项目对象废弃。
4. 资产引用 policy 默认 `follow_latest_compatible`，UI 不暴露选择。

---

## 一、目标架构（重构后）

```
Conversation.space_id (string | null)
  - null = orphan，不挂空间，空间任务/产物列表不纳入

空间直接持会话（不再靠 project 反查）：
  - 任务 = conversation.space_id == spaceId 的会话
  - 产物 = 这些会话的附件 + artifacts（按会话目录聚合）
  - 资产 = asset_reference_bindings 引用的全局资产（route A）

项目对象废弃，其承载的功能安置（默认方案）：
  1. 资源作用域：空间 extra_skills/extra_agents + 模板 bundle 已够，project.bindings 废弃
  2. 项目文件树（project_files.ts，892行）：挂到空间下 → 空间文件树（或砍掉，见开放问题）
  3. 项目任务（project_tasks.ts，432行）：砍掉——空间内「任务」= 会话，不再需要额外 task 对象
  4. 项目库索引（project_library_indexer.ts，703行）：挂到空间下 → 空间库索引
```

## 二、牵连面总览（扫描结果）

- **后端 `project_id/projectId` 引用：51 个文件**，含 group_chat/bus.ts（执行核心）、model/core-agent/*（全部工具）、chats.ts、spaces.ts、auto_tasks.ts、recall/*、search/*、messaging/* 等。
- **前端 `project_id/projectId` 引用：22 个文件**，含 conversation.js、project-detail.js（3499行）、projects.js（1050行）、agents.js、skills.js 等。
- **项目专用模块（要废弃/迁移）**：后端 projects.ts(755)/project_tasks.ts(432)/project_files.ts(892)/project_library_indexer.ts(703)；前端 projects.js(1050)/project-detail.js(3499)/project-workbench.js(308)。
- **IPC：40 个 `projects.*` handler**，含 projects.files.*（14个）、projects.tasks.*（5个）、projects.bindings.*（4个）等。
- **已有迁移脚本先例**：`src/main/util/migrate-project-layout-v4.ts`（含 `MIGRATION_VERSION`、`moved_conversations/moved_sessions/moved_attachments/moved_artifacts` 统计），可作为本次 v5 迁移的模板。
- **执行核心路径**：`group_chat/bus.ts` 里 `resolveProjectScope(uid, projectId)` 在 `runTurn` 热路径上调用，判断会话资源作用域（S∪B）。这是删法 B 最危险的改动点——改错会导致会话执行作用域全错。
- **测试基线**：24 个 *.test.ts 文件（`npm run test:js`），其中 agent-runner.test.ts、cli.test.ts 等直接或间接触发会话执行链路。

---

## 三、分阶段精细任务

> 每阶段是一个可独立提交、可独立验证的原子单元。阶段间有依赖，必须按序执行。
> 每个任务 = 2-5 分钟粒度，附精确文件路径 + 验收标准。

### 阶段 0：数据模型 + 存量迁移（地基，最危险，必须先做）

**目标**：`Conversation.space_id` 字段落地 + 存量 `project_id` 迁移，期间双字段兼容，不破坏现有执行链路。

- [x] **T0.1 新增迁移脚本骨架**：复制 `migrate-project-layout-v4.ts` 为 `migrate-project-layout-v5.ts`，`MIGRATION_VERSION = 5`，先实现「统计存量」只读逻辑（列出所有 project、其 space_id、其会话数），不写盘。
  - 文件：`src/main/util/migrate-project-layout-v5.ts`
  - 验收：`npm run smoke` 后能打印存量统计，不报错。
  - ✅ 完成（2026-08-13）：`collectProjectSpaceStats(uid)` 只读统计（projects_total/with_space/orphan、conversations_*、by_project 明细）+ `migrateProjectLayoutV5(uid)` skeleton 入口（只打日志不写盘）。验证证据：`npm run typecheck` 通过；构造临时数据根（2 项目：1 带 space_id 含 1 墓碑、1 orphan）跑断言全过；`npm run smoke` OK。风险：`readJsonSync` 静默返回 `{}`，读不到 meta 的项目 space_id 记 null 不中断；孤儿会话计数按 `chats/_index.json` 非墓碑行统计，与 `getProjectConversationCounts` 的 deleted 过滤口径一致。
- [x] **T0.2 会话索引加 space_id 字段**：`chats.ts` 的 `Conversation` 接口 + `_normaliseConversation` 增加 `space_id?: string`（读旧数据兼容），`createConversation` 支持传入。
  - 文件：`src/main/features/chats.ts:94`（接口）、`:251`（normalise）
  - 验收：`node --check` 通过；`npm run test:js` 不新增失败。
  - ✅ 完成（2026-08-13）：`Conversation` 加 `space_id?`；`_normaliseConversation` 读 `raw.space_id`（旧数据无字段时缺省，向后兼容）；`CreateConversationOptions.spaceId?` + `createConversation` 解构 `spaceId=''` 并在 created/revived 两处落 `space_id`；`CLEARABLE_CONVERSATION_FIELDS` 加 `'space_id'`（同步合并清字段口径与 project_id 一致）。验证证据：`npm run typecheck` 通过；`npm run test:js` 18 failed files / 69 failed tests（7811 passed）——全部为基线既有失败（recall actor 校验、renderer category-tabs/conversation-copy-merge、p3394 KSTAR、builtin-resource-gate 等），与本次 space_id 改动无关，**新增失败 0**。风险：space_id 读取未做 safeId 校验（与 project_id 同口径，IPC 层负责校验存在性）。
- [x] **T0.3 迁移执行逻辑**：v5 迁移脚本实现「对每个 project，若有 space_id，则把该项目下所有会话的 `project_id` 复制到 `space_id`，并写入新归档目录」。
  - 关键：`cloud/projects/<pid>/...` → `cloud/spaces/<sid>/...`（会话、附件、artifact、group_chat、session 全部搬）。
  - 文件：`src/main/util/migrate-project-layout-v5.ts` + `src/main/paths.ts`（新增 `spaceChatsDir` 等路径函数）
  - 验收：构造一个含 project+space_id 的测试数据，跑迁移，断言文件落到 `cloud/spaces/<sid>/` 且会话 JSON 带 space_id。
  - ✅ 完成（2026-08-13）：`paths.ts` 新增 `spaceContentDir/spaceChatsDir/spaceChatIndexFile/spaceGroupChat*/spaceSessionsDir/spaceSession*/spaceChatAttachmentsDir/spaceChatArtifactsDir/spaceArtifactDir` 全套（含 `assertSpaceSegment` 路径段防护）；空间内容目录 `cloud/spaces/<sid>/` 与空间 meta 单文件 `cloud/spaces/<sid>.json` 同层共存（`_listSpaceIds` 只认 `.json` 文件，不冲突）。`migrateProjectLayoutV5` 实现搬移：索引行打 `space_id`（`= project.space_id`，**非** `= conversation.project_id`，已按目标架构消歧）+ 多项目同空间按 cid 合并索引、chats(jsonl+group)/sessions/attachments/artifacts 整目录搬（目标存在→逐文件合并、冲突→`.legacy-v5-<hash>` 保留不覆盖）。验证证据：`npm run typecheck` 通过；构造 3 项目（2 指向同一空间 + 1 orphan）跑迁移断言全过（空间索引 3 行全带 space_id 且 project_id 保留、文件落 `spaces/<sid>/`、orphan 原地不动）；`npm run smoke` OK。风险：未加锁/未建 marker/未注册（T0.4 补）；orphan 项目本阶段不搬，其 `projects/<pid>/` 待阶段 4 清。
- [x] **T0.4 迁移注册 + 幂等**：在 `boot_init` 注册 v5 迁移（参考 v4 的注册点），加锁 + 版本标记，重复启动不重复迁移。
  - 文件：`src/main/util/boot_init.ts`
  - 验收：连跑两次 smoke，第二次迁移统计为 0（幂等）。
  - ✅ 完成（2026-08-13）：v5 迁移加 `markerFile`(`local/migrations/project-layout-v5.json`，版本=5)/`lockFile`(wx+pid+stale 10min)/`alreadyApplied`/`acquireMigrationLock`；`migrateProjectLayoutV5(uid, {force?})` 幂等（marker 命中直接返回空统计）+ 加锁 + 写完 marker。**注册点修正**：实际注册在 `features/users.ts::activateUser`（紧接 v4 之后），非 plan 原写的 `boot_init.ts`——v4 的注册点本来就在 activateUser，boot_init.ts 只管 boot 阶段调度不挂迁移。验证证据：`npm run typecheck` 通过；fixture 连跑 3 次（第 1 次搬 1 会话、第 2 次 0、第 3 次 force 0 且索引不重复）断言全过；`npm run smoke` OK。🔴 风险（阶段 0~3 中间态）：注册后对真实数据启动会搬走已绑空间的会话，而执行路径（conversationLayout/resolveProjectScope）仍读 projects/，导致这些会话暂时不可见——需阶段 4（T4.1）改空间根后整体对外。开发期勿对真实数据跑完整 app。

### 阶段 1：空间三 tab 数据层（依赖阶段 0）

**目标**：新增「空间 → 任务/产物/资产」三个查询函数 + IPC，前端可读真数据。

- [x] **T1.1 空间任务列表**：`spaces.ts` 新增 `listSpaceConversations(uid, spaceId)`，直接查 `conversation.space_id == spaceId`（阶段0后不再是 project 反查），合并排序返回。
  - 文件：`src/main/features/spaces.ts`
  - 验收：单测或 smoke 验证返回该空间下会话列表。
  - ✅ 完成（2026-08-13）：**实现于 `chats.ts`**（非 plan 原写的 spaces.ts——会话归一化/排序/索引读取器均为 chats.ts 私有，放 spaces.ts 需反向依赖；spaces.ts 保持纯配置实体）。`listSpaceConversations(userId, spaceId)`：先读空间自有索引 `spaceChatIndexFile`（v5 迁移后/空间根落点），再扫全局+项目根兜底双字段兼容期带 space_id 的会话，按 conversation_id 去重（空间索引优先）、过滤墓碑、活动倒序。验证证据：`npm run typecheck` 通过；fixture（空间索引 2 行含 1 墓碑 + 全局 1 双字段 + 1 orphan）断言返回 2 条（空间索引+双字段）、排除 orphan 和墓碑、空空间/非法 spaceId 返回 []。
- [x] **T1.2 空间产物聚合**：新开 `src/main/features/spaces_artifacts.ts`，遍历空间会话 → `chat_attachments.listAttachments(uid, cid)` + artifact 目录扫描，统一成 `{name, type, ext, sourceSessionId, time}` 形状。
  - 文件：`src/main/features/spaces_artifacts.ts`
  - 验收：返回统一产物列表，附件和 artifact 都在。
  - ✅ 完成（2026-08-13）：`spaces_artifacts.ts` 的 `listSpaceArtifacts(uid, spaceId)` 遍历 `listSpaceConversations` 结果，直接扫空间附件目录 `spaceChatAttachmentDir`（`ALLOWED_EXTENSIONS` 白名单过滤）+ 空间产物目录 `spaceChatArtifactCidDir`（读 `__cogseed-meta.json` 取标题/createdAt），统一 `{name,type:'attachment'|'artifact',ext,sourceSessionId,time,artifactId?}`，按时间倒序。**关键偏差**：未复用 `chat_attachments.listAttachments`/`artifactDirForConversation`——两者经 project-layout 按 project_id 解析（尚不支持空间根），v5 已把已绑空间会话的附件/产物搬到 `spaces/<sid>/`，故直接读空间路径与迁移落点对齐（阶段 4 统一后可收敛）。验证证据：`npm run typecheck` 通过；fixture（空间 1 会话 + 2 附件 + 1 artifact 带 meta 标题）断言附件/产物齐全、标题/时间/类型正确、空空间返回 []。
- [x] **T1.3 空间资产引用（路线 A 激活死字段）**：`spaces.ts` 新增 `bindSpaceAsset` / `unbindSpaceAsset` / `listSpaceAssetBindings`，读写 `asset_reference_bindings`；绑定默认 policy=`follow_latest_compatible`；回填资产 title/type 用 `recall/asset-service.ts` 的 `listAbilityAssets`。
  - 文件：`src/main/features/spaces.ts`（字段已存在，加读写函数）
  - 验收：绑定/解绑/列出走通，policy 默认 follow_latest。
  - ✅ 完成（2026-08-13）：`bindSpaceAsset(uid, spaceId, ref)`（policy 缺省 `follow_latest_compatible`，同 asset_id 幂等覆盖 version/policy/updated_at，非法 ref → `invalid_ref`）；`unbindSpaceAsset`（按 asset_id 移除，空则清字段）；`listSpaceAssetBindings`（回填 title/asset_type，用动态 import `recall/asset-service.listAbilityAssets`，失败静默降级为空回填）；新增 `SpaceAssetBindingView` 展示类型。验证证据：`npm run typecheck` 通过；fixture（构造 recall 资产 schemaVersion/ownerId/id 完整）断言默认 policy、幂等覆盖、显式 policy、非法 ref、回填 title/type、解绑、not_found 全过。风险：回填依赖 recall 资产读取器，其校验较严（schemaVersion/ownerId/id 必填），资产缺失时 title/type 缺省为 undefined（UI 侧需容忍）。
- [x] **T1.4 IPC 三个 handler**：`ipc/index.ts` 加 `spaces.conversations.list`、`spaces.artifacts.list`、`spaces.assets.list`（+ assets.bind/unbind）。
  - 文件：`src/main/ipc/index.ts`
  - 验收：`npm run typecheck` 通过；前端可 invoke 拿到数据。
  - ✅ 完成（2026-08-13）：新增 5 个 handler——`spaces.conversations.list`（→chats.listSpaceConversations）、`spaces.artifacts.list`（→spacesArtifacts.listSpaceArtifacts）、`spaces.assets.list`（→spaces.listSpaceAssetBindings）、`spaces.assets.bind`（→spaces.bindSpaceAsset）、`spaces.assets.unbind`（→spaces.unbindSpaceAsset），均 `safeId` 校验 spaceId、错误 throw（与既有 spaces.* handler 同款）。`import * as spacesArtifacts` 已加。验证证据：`npm run typecheck` 通过；handler 键唯一无冲突；`npm run test:js` 18 failed files / 69 failed tests（7811 passed）——与基线完全一致，**新增失败 0**（grep 新增符号零命中）。前端 invoke 真数据渲染留待阶段 2（CDP）。

### 阶段 2：空间三 tab 前端（依赖阶段 1）

**目标**：`workspace.js` 三个 tab 从空态换成真数据渲染。

- [ ] **T2.1 任务 tab**：`workspace.js` 任务 tab 调 `spaces.conversations.list`，渲染会话行（复用 `ws-session-row`）。
- [ ] **T2.2 产物 tab**：调 `spaces.artifacts.list`，渲染产物卡（复用 `ws-artifact-card`）。
- [ ] **T2.3 资产 tab**：调 `spaces.assets.list`，渲染资产卡（复用 `ws-asset-card`），含绑定/解绑交互（解绑走 `spaces.assets.unbind`）。
  - 文件：`src/renderer/modules/workspace.js`（三个 tab 各自 `_render*Pane`）
  - 验收：CDP 实测三 tab 显示真数据；空态正常。

### 阶段 3：废弃项目 UI（依赖阶段 2）

**目标**：侧边栏不再显示项目，会话直接显示在空间下。

- [ ] **T3.1 删侧边栏项目区块**：`index.html` 删 `sidebar-projects-section`（41-50行）。
  - 文件：`src/renderer/index.html`
- [ ] **T3.2 停用 projects.js 渲染**：`boot.js`/`state.js` 移除 `renderProjectsSection` 调用；`interactive-tour.js:40-62` 的项目选择器改为走空间选择器。
  - 文件：`boot.js`、`state.js`、`interactive-tour.js`
- [ ] **T3.3 删 panel-project 路由**：`boot.js` 删 `project` view 分支 + panel 映射；`lazy-features.js` 删 project 条目。
  - 验收：点侧边栏无项目入口，无残留报错。

### 阶段 4：废弃项目后端（依赖阶段 3，最重）

**目标**：40 个 `projects.*` IPC 处理 + 项目功能迁移/砍掉 + 会话执行路径改空间作用域。

- [ ] **T4.1 会话执行作用域改造（最高风险）**：`group_chat/bus.ts` 里 `resolveProjectScope(uid, projectId)` → 改成 `resolveSpaceScope(uid, spaceId)`，读 `conversation.space_id`，作用域直接取空间派生集。
  - 文件：`src/main/features/group_chat/bus.ts`（约1926、3174、3190行）
  - 验收：`npm run test:js` 全绿，尤其 agent-runner/cli 测试。
- [ ] **T4.2 砍 project_tasks**：删 `project_tasks.ts` + `projects.tasks.*` IPC（空间内任务=会话，不再需要）。
- [ ] **T4.3 迁移 project_files → 空间文件树**：`project_files.ts` 改为按 space_id 组织，`projects.files.*` IPC 改为 `spaces.files.*`（或砍掉，见开放问题）。
- [ ] **T4.4 迁移 project_library_indexer → 空间库索引**：索引键从 project_id 改 space_id。
- [ ] **T4.5 删 projects.ts 主模块**：确认无引用后删除，清理 40 个 projects.* IPC。
- [ ] **T4.6 清理残留引用**：`grep -rn "project_id\|projectId" src/` 逐文件清，直到项目相关引用归零（除迁移脚本 v4/v5 保留）。

### 阶段 5：清理 + 验收（依赖阶段 4）

- [ ] **T5.1 全量测试**：`npm run typecheck` + `npm run test:js` + `npm run smoke`。
- [ ] **T5.2 数据迁移回归**：用含项目+空间的真实/样例数据全流程迁移，验证会话、文件、资产引用完整。
- [ ] **T5.3 删 UI 残留样式**：`style.css` 清理 projects 相关 class（可选，非阻塞）。

---

## 四、开放问题（执行前需再确认）

1. **项目文件树（project_files.ts）**：删法 B 后，项目文件树是「挂到空间下」还是「砍掉」？默认挂空间下（空间文件树），但若空间不需要文件树则砍掉，省 892 行。
2. **项目库索引（project_library_indexer.ts）**：同样挂空间 or 砍掉？这影响 KB 检索的粒度。
3. **存量无 space_id 的项目**：迁移时，某项目没绑空间（space_id 空），它下面的会话迁到哪？默认：迁到 orphan（space_id=null），其文件挪到 orphan 归档目录。

---

## 五、风险与纪律

- **🔴 最高风险**：T4.1 会话执行作用域改造。`resolveProjectScope` 在 runTurn 热路径，改错会导致所有会话执行作用域错误（技能/智能体全错）。必须 TDD + 跑满测试。
- **🔴 迁移必须幂等 + 有回滚**：存量数据迁移一旦写错目录，用户数据就乱了。v5 迁移要：加锁、版本标记、迁移前备份统计、幂等重入。
- **顺序纪律**：阶段 0→1→2→3→4→5 严格依赖，不可跳。特别是「先建 space_id 字段并迁移（阶段0），再改执行路径（T4.1）」，否则中间态执行会断。
- **不加新 npm 依赖**（AGENTS.md 铁律）。
- **不用 mock 兜底**：API 空就显示空态，不编造数据。
- **renderer 改完要重启 app 验证**（classic script，无热更新）。
- 每次 commit 带 `feat:` / `refactor:` / `migrate:` 前缀，阶段内频繁提交。

---

## 六、执行方式（二选一）

1. **subagent-driven-development**：每任务 dispatch 一个 subagent，两段评审（spec 合规 + 代码质量）。
2. **progress-driven-cron-execution**：建 PROGRESS.md，cron 每 tick 推进一个原子任务。

推荐后者（工程大、周期长），PROGRESS.md 首版即本文件的阶段总览表 + 待办清单。
