# 2026-08-17 空间工作区与认知资产引用链路 交接文档

> 日期：2026-08-17
> 分支：`dev/zhanghao-space-recall-2026-08-17`（已本地合入 `origin/develop @ 888fd726`，已 push）
> 状态：本线交付的功能闭环与合并纪律说明——后续修改不得删除、覆盖、降级或绕过下述产品决策。
> 一句话交接：**一个空间 = 一个文件夹（CLI 智能体 cwd 进空间、空间文件夹只放产物）；资产池全局共享（引用看全池，tab 按空间过滤）；AI 可主动检索资产池；预载卡片已移除。**

---

## 0. 给后续开发者 / AI 的最高优先级指令

修改本线任何文件前，必须先阅读本文档。

### 0.1 禁止事项（除非有明确新产品决策 + 迁移方案）

- **禁止**把外接 CLI 智能体（WorkBuddy / Claude Code / Codex 等）在空间会话的 cwd 改回全局根工作区 `userWorkSpace`——空间会话的工作目录必须在 `spaces/<sid>/workspace/<slug>`（slug 冻结在 `state.workspace_dir`，保证 CLI session-store 按 cwd 哈希的 resume 稳定）。
- **禁止**把聊天上传附件重新放回空间文件夹（`spaces/<sid>/chat_attachments/`）——上传附件一律在全局 `cloud/chat_attachments/<cid>/`；空间文件夹只放 AI 产物（`workspace/`、`chat_artifacts/`）与元数据。
- **禁止**给空间会话的引用（注入/投影）加"只显示本空间资产"的硬过滤——产品决策是**资产池全局共享**：空间会话可引用整个池子（含其它空间产生的资产与全局资产）；只有资产 tab（`listAbilityAssetsForSpace`）按 `spaceId` 过滤。
- **禁止**把预载卡片交互加回来——引用资产走"自动注入 + LLM 主动检索（`search_ability_assets`）"，不再展示可交互的预载确认卡片。
- **禁止**恢复"任务类型词闸门"对 `space`/`general` 资产的全量误杀——真实资产 scope 多为 `space`/`general`，`scopeAppliesToPurpose` 让它们不被 purpose 词过滤；`review`/`report`/自定义词条仍走软匹配。
- **禁止**删除 `search_ability_assets` 工具或其注入（所有主会话 runner 都有，read-only）。

### 0.2 与既有保护线的兼容约定

- **Commander-Centric KStar 六条产品决策**（见 `2026-08-17-commander-centric-kstar-handover`）与本线兼容：本线采用其"沉淀单路径收口"（drain 不产候选，KStar 候选统一走 requirement 级路径）；不动适合度注入（0.40 阈值）、回执闭环、语言硬闸。
- **P3394 保护文件**（见 P3394 Bridge Runtime 合入交接文档）零改动——本线未触碰任何 P3394 文件。

---

## 1. 功能模块清单（本线交付）

### 1.1 空间工作区（`src/main/features/group_chat/`、`src/main/features/cogseed_backend/`、`src/main/util/`）

| 文件 | 职责 | 关键契约 |
|---|---|---|
| `group_chat/bus.ts` | CLI 智能体分支 cwd 空间化 | `turnSpaceId` 存在时 `wsRoot = getConversationWorkspacePath(uid, cid)` → `spaces/<sid>/workspace/<slug>`；agent 详情页显式自定义目录（`custom_path`）仍优先；非显式 `coding_project_dir` 落在空间工作区外 → 下次派发自动重指（懒修复，幂等）；未绑空间会话保持根工作区 |
| `cogseed_backend/local-cli-execution-adapter.ts` | p3394 网关路径空间感知 | `defaultWorkingDir`：显式自定义目录优先 → 会话挂空间 → `getConversationWorkspacePath`；否则原逻辑 |
| `util/project-layout.ts` | 附件落位 | `chatAttachmentDirForConversation` / `chatAttachmentRelPath` 忽略 spaceHint → 上传附件统一全局 `cloud/chat_attachments/<cid>/`（项目作用域保留）；网页产物（`chatArtifactCidDirForConversation`）仍进空间目录 |
| `features/spaces_artifacts.ts` | 附件迁移方向 | `migrateSpaceAttachments`：附件 空间→全局（历史迁入的搬回）；网页产物仍 全局→空间；`scanAttachments` 双目录读（兼容遗留） |
| `util/migrate-project-layout-v5.ts` | v5 布局迁移 | 项目附件按 cid 搬到全局，不再进空间目录 |

### 1.2 Recall 引用链路（`src/main/features/recall/`、`src/main/features/kstar/`）

| 文件 | 职责 | 关键契约 |
|---|---|---|
| `recall/context-projection.ts` | 引用候选与投影 | **引用=资产池全局共享**（buildRecallView / createAutomaticContextProjection / isAssetEligibleForProjection 三处一致）：空间会话可引用整个池子；workspace-ref 仅作可选收紧（显式停用 / scope 词）；`scopeAppliesToPurpose`：`*`/`general`/`space` 不按 purpose 过滤，其余走 `scopeIncludes` 软匹配；0.40 语义阈值 / 相对显著性 0.5 / Top-8 契约未动 |
| `recall/candidate-service.ts` | 晋升出口 | `promoteRecallCandidate` 成功后，资产带 `spaceId` 时自动 `addWorkspaceAssetReference`（幂等，失败不阻断确认）——所有晋升路径统一收口；autoApply 语义查重 / 晋升闸 / 指纹去重未动 |
| `kstar/recall-bridge.ts` | drain 桥 | 保留 `options.spaceId` 兼容参数（收口后无调用方，兼容签名）；suggestedAction 类型收窄（合入远程修复） |
| `kstar/requirement-types.ts` | 类型补全 | `KstarRequirementRecord.workspaceId?: string`（store 一直在存/校验，类型漏了） |
| `kstar/task-aggregate.ts` | 任务状态关闭 | 采用 Commander-Centric"沉淀单路径收口"：drain 不产候选（proposals/candidates 恒空），只做任务/会话状态关闭 |

### 1.3 搜经验工具与前端（`src/main/model/core-agent/`、`src/renderer/`）

| 文件 | 职责 | 关键契约 |
|---|---|---|
| `model/core-agent/recall-tools.ts`（**新建**） | `search_ability_assets` 工具 | LLM 主动语义检索**全局资产池全量**（active 只读），支持 `scope`/`spaceId` 过滤，返回标题/内容/类型/空间/成熟度/相关度 + 引用格式 `[asset:<id>]`；embedding 失败降级关键词匹配；`executionMode: 'parallel'` |
| `model/core-agent/runner.ts` | 工具注入 | `createRecallTools` 注入所有主会话 runner（与 kb 工具同级，read-only 无需 localExec） |
| `model/core-agent/tool-catalog.ts` | 工具注册 | `search_ability_assets`（新 group `recall`，`ToolGroup` 联合类型加 `'recall'`） |
| `renderer/modules/conversation.js` | 去预载卡片 | 移除 `recall_projection_card` 交互挂载；历史卡片消息以普通文本呈现（主进程投影数据层保留，KStar 沉淀链依赖；发卡 IPC 保留为死代码） |

---

## 2. 产品决策（不得视为可优化细节）

1. **一个空间 = 一个文件夹**：空间会话的 AI 产物、CLI 智能体 cwd 都在 `spaces/<sid>/workspace/<slug>`；打开空间文件夹 = 看到这个空间的产物。
2. **空间文件夹只放产物**：聊天上传附件一律全局 `cloud/chat_attachments/<cid>/`（与主流 coding agent 一致：项目/空间文件夹保持干净，上传放别处）。
3. **引用 = 资产池全局共享**：空间会话能引用整个池子（包括别的空间产生的资产）；**只有 tab 显示按空间过滤**。
4. **AI 主动检索**：`search_ability_assets` 让 LLM 需要时自己搜全局资产池（与注入互补）。
5. **预载卡片移除**：引用走自动注入 + 主动检索，不再有用户确认卡片的交互。
6. **资产晋升自动挂登记卡**：promote 后资产带 spaceId 即自动 `addWorkspaceAssetReference`（workspace-ref 是可选收紧控制，不是引用前置）。
7. **scope 词闸门豁免**：`space`/`general` 资产不被任务类型词误杀（真实资产形态）。

---

## 3. 合并纪律

### 3.1 归属边界（本线文件，改动前先读本文档）

```
src/main/features/group_chat/bus.ts            （CLI cwd 空间化段；注意：同文件还有 commander-centric 的注入/回执/准入段，勿混）
src/main/features/cogseed_backend/local-cli-execution-adapter.ts
src/main/util/project-layout.ts                （附件落位段）
src/main/features/spaces_artifacts.ts          （附件迁移方向段）
src/main/util/migrate-project-layout-v5.ts
src/main/features/recall/context-projection.ts （引用候选/scope 闸段；同文件还有 0.40 阈值等 commander-centric 契约）
src/main/features/recall/candidate-service.ts  （promote 自动挂 ref 段）
src/main/features/kstar/recall-bridge.ts
src/main/features/kstar/requirement-types.ts   （workspaceId 声明）
src/main/model/core-agent/recall-tools.ts      （新建，全文件本线）
src/main/model/core-agent/runner.ts            （recallTools 注入段）
src/main/model/core-agent/tool-catalog.ts      （recall group + 注册行）
src/renderer/modules/conversation.js           （去卡片段）
```

### 3.2 共享文件注意事项

- `bus.ts` / `context-projection.ts` / `candidate-service.ts` / `recall-bridge.ts` 同时是 **Commander-Centric KStar 保护文件**——冲突必须**逐块语义合并**，禁止整体 ours/theirs；MR 描述中显式标注"涉及受保护文件改动及原因"。
- **P3394 文件零改动**（保持）。

### 3.3 验收：什么算"功能完好"（真实链路为准）

- 空间会话让 WorkBuddy 干活 → cwd = `spaces/<sid>/workspace/<slug>/`（state 中 `coding_project_dir` 指向空间目录，不再指向 `userWorkSpace` 根）；
- 空间会话上传附件 → 落全局 `cloud/chat_attachments/<cid>/`；空间文件夹只有 `workspace/` 产物与元数据；
- 空间会话注入 → commander 提示块含资产引用（含**其它空间/全局资产**，全局池共享）；资产 tab 只显示本空间（`recall.assets.listForSpace`）；
- AI 可用 `search_ability_assets` 搜到全局池任意 active 资产（返回 `[asset:<id>]` 引用格式）；
- 新确认的带 spaceId 资产自动挂 workspace-ref（`recall.workspaceRefs.list` 可见）。

---

## 4. 已知边界 / 遗留（可后续演进，需先确认）

1. **发卡 IPC 与 `projection-message.ts` 是死代码**（预载卡片已移除，主进程接口保留）——建议后续清理，需先确认无人调用。
2. **`recall-bridge.ts` 的 `options.spaceId` 兼容参数无调用方**（drain 收口后）——保留符合"兼容签名"，可后续移除。
3. **同一空间内占位标题会话的 slug 可能撞名**（如两个"新对话"都冻结成 `chat-YYYY-MM-DD-N`）→ 共享空间内同一子目录；文件重名由 uniquify 兜底。如需彻底唯一，slug 生成需检查同空间其他会话。
4. **`suggestedScope` 语义混杂**（`space`/`general`/任务词并存）——`scopeAppliesToPurpose` 已豁免 space/general；若产品要更细的引用范围控制，可演进 scope 词体系。
5. 本线未包含的：`spaces.js`/`workspace.js`/`workspace.css`/`workspace-role-picks.test.ts` 为其他在途改动（如「新建空间基础 Agent 多选」），不属于本线，勿混入本线提交。

---

## 5. 测试基线

- 本线测试：`test/main/features/recall/`、`test/main/features/kstar/`、`test/main/features/group_chat/bus.test.ts`、`test/main/features/cogseed_backend/local-cli-execution-adapter.test.ts`、`test/main/features/spaces_artifacts.test.ts`、`test/main/model/core-agent/recall-tools.test.ts`（新建）。
- 关键用例：空间会话 CLI cwd 路由 / 存量懒修复 / 附件全局解析与反向迁移 / 全局池共享引用（异空间资产可引用、可自动注入）/ scope=space·general 真实形态通过闸门 / promote 自动挂 ref 幂等 / 搜经验工具全池检索。
- 运行：`node scripts/run-tests.mjs run test/main/features/recall test/main/features/kstar test/main/features/group_chat test/main/model/core-agent`（当前 1797 用例全过；全量 229 文件 / 2513 用例全过）。
- 已知 develop 上游固有失败（非本线）：renderer 若干（develop 基线一致）。
