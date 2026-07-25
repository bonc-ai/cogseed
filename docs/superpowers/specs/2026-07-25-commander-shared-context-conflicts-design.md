# Commander Shared Context Conflict Resolution Design

> 日期：2026-07-25
> 版本：v0.1
> 适用产品：Mate Agent / Orkas Agent Commander Collaboration Runtime
> 状态：已确认，进入实施计划

## 1. 目标

为当前会话的 Orkas Agent / Commander 增加一套最小可用的共享上下文冲突闭环：专业 Agent 只能提交结构化提案，Collaboration Runtime 检测同一主题下的不同意见、阻塞受影响步骤，Commander 主持核查或决策，解决后写入正式上下文并恢复步骤。

这项能力不是新增一个“协作控制器 Agent”。Commander 仍是会话唯一主持人；Runtime 只负责确定性状态维护、依赖阻塞、恢复和审计。

## 2. 核心角色

- **用户**：目标、硬约束和高风险决策的最终所有者。
- **Orkas Agent / Commander**：会话主持人、冲突仲裁者和最终交付负责人。
- **专业 Agent**：读取当前步骤所需的上下文投影，返回结果、证据和 proposed patch。
- **Collaboration Runtime**：保存 proposal/conflict、执行局部阻塞和恢复，不作产品或专业判断。
- **P3394**：记录 delegate/query/negotiate 的身份、session、correlation 和冲突关联。
- **KSTAR**：提供结果和工具证据质量信号，不直接替代 Commander 决策。

## 3. 设计原则

1. 不把完整会话暴露给所有 Agent；继续使用 visibility slice。
2. Shared Task Context 是 Commander 拥有的中央账本，不是多写者公共文档。
3. Agent 的决策输出默认是 proposal，不直接成为 accepted decision。
4. 不采用后写覆盖或多数投票。
5. 冲突只阻塞声明依赖该 context key 的步骤，不默认阻塞整个 workflow。
6. 所有冲突必须有稳定 id、topic、来源、证据、状态和解决记录。
7. 第一版最多支持一次核查/一次仲裁入口，不实现无限自动辩论。
8. 用户审批仍在主会话完成；协作概览只展示和定位。
9. 不增加 npm 依赖，不新增平行 dispatch path。

## 4. 数据模型

### 4.1 Context Proposal

```ts
export type ContextProposalKind = 'fact' | 'decision' | 'recommendation';
export type ContextProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface ContextProposal {
  id: string;
  conflict_key: string;
  kind: ContextProposalKind;
  text: string;
  reason?: string;
  evidence_refs: string[];
  confidence: ContextConfidence;
  proposed_by: string;
  status: ContextProposalStatus;
  created_at: string;
  resolved_at?: string;
}
```

`conflict_key` 是稳定、机器可比较的主题键，例如：

- `market.entry_mode`
- `architecture.database_strategy`
- `report.primary_recommendation`

没有 `conflict_key` 的旧 `decisions_proposed` 保持现有兼容行为，不进入自动冲突检测。

Agent wire contract 扩展为：

```ts
export interface DecisionDraft extends ContextItemDraft {
  reason?: string;
  conflicts_with?: string[];
  conflict_key?: string;
  proposal_kind?: 'decision' | 'recommendation';
  conflict_type?: ContextConflictType;
  evidence_refs?: string[];
}

export interface ContextPatch {
  base_context_revision?: number;
  // existing patch fields...
}
```

默认映射固定为：`proposal_kind = 'decision'`，`conflict_type = 'recommendation'`。只有通过 enum 校验的显式值才能覆盖默认值。`fact` proposal 留给后续独立 `facts_proposed` 协议，本阶段不把 `facts_add` 自动改成 proposal。

### 4.2 Context Conflict

```ts
export type ContextConflictType =
  | 'fact'
  | 'recommendation'
  | 'implementation'
  | 'quality'
  | 'preference'
  | 'safety';

export type ContextConflictStatus =
  | 'detected'
  | 'gathering_evidence'
  | 'under_review'
  | 'awaiting_user'
  | 'resolved'
  | 'dismissed';

export interface ContextConflictResolution {
  decision: 'accept' | 'reject' | 'merge';
  selected_proposal_ids: string[];
  text: string;
  reason?: string;
  resolved_by: string;
  resolved_at: string;
}

export interface ContextConflict {
  id: string;
  conflict_key: string;
  type: ContextConflictType;
  status: ContextConflictStatus;
  proposal_ids: string[];
  affected_step_ids: string[];
  resolution?: ContextConflictResolution;
  created_at: string;
  updated_at: string;
}
```

### 4.3 Shared Task Context 扩展

```ts
export interface SharedTaskContext {
  // existing fields...
  revision: number;
  proposals: ContextProposal[];
  conflicts: ContextConflict[];
}
```

旧 `version: 1` 文件读取时迁移为：

```ts
revision = 0
proposals = []
conflicts = []
```

每次 context write 将 `revision + 1`，让 P3394 和并行 Agent 返回值能够声明 `base_context_revision`。

### 4.4 Workflow Step 扩展

```ts
export interface WorkflowStep {
  // existing fields...
  context_dependencies?: string[];
  blocked_by_conflict_ids?: string[];
}
```

只有 `context_dependencies` 包含冲突 `conflict_key` 的 pending step 会被标记为 blocked。

## 5. Context 生命周期前置

Commander 一旦执行首个 `dispatch_to`、`hand_off_to` 或 `run_worker`，必须在目标 Agent 启动前调用一个原子的 `ensureActiveWorkflowRun`。首次并行 fan-out 只能创建一个 WorkflowRun/SharedTaskContext。实现采用“公开加锁 wrapper + 已持锁 unlocked helper”，避免 `recordNestedDispatchStep` 在同一 conversation mutex 中重入死锁。

匿名 worker 不进入 roster，但如果返回 `<context-patch>`，Bus 仍要对其结果执行同一 patch 提取与 active context 合并；不得创建第二条 context 路径。

真实 `dispatch_to`、`hand_off_to` 和 `run_worker` 必须允许声明 `context_dependencies`。Runtime 在 Agent 启动前创建或复用一个 workflow step：若依赖 key 存在 active conflict，step 记录为 blocked、Agent 不启动，工具返回稳定 `step_id`；冲突解决后 step 变为 pending，Commander 使用该 `step_id` 重试并启动同一步，不能创建重复 step。这里不恢复旧 DAG executor，执行仍由 Commander 的结构化 dispatch tool 驱动。

同一 pending Wake intent 只能绑定一个 workflow step。重复派工创建的临时 step 必须被标记 skipped/superseded，现有 Wake request 的 step 获胜；legacy request 缺少 step id 时原子绑定首次新 step。Wake reject 将绑定 step 标记 skipped，approval 执行该 exact step。Agent turn 的 step lifecycle 由 `runActorTurn` 外层 wrapper 统一 start/finish，覆盖所有 early return、throw、abort 和正常返回，保证 exact-once settlement。

正常顺序固定为：

```text
Commander 决定委派 + 声明 context dependencies
→ ensure WorkflowRun + SharedTaskContext
→ prepare/reuse workflow step（保持 pending/blocked）
→ conflict guard（blocked 则停止）
→ Wake Gate（若待批准，把 workflow_step_id 持久化到 request）
→ QueueItem 携带 workflow_step_id
→ Agent turn 开始时 start 同一步
→ 执行 Agent 并应用 proposed patch
→ turn 结束时 complete 同一个 dispatch step/result
```

## 6. 冲突检测规则

第一版只对带 `conflict_key` 的 proposal 自动检测，避免对任意自然语言做高误报语义判断。

检测流程：

1. 将 proposal text 规范化：trim、合并空白、lowercase。
2. 同一 `conflict_key` 下内容相同则去重。
3. 同一 key 下出现不同 pending proposal，创建或更新一个 active conflict。
4. proposal 保留为 pending，不写入 accepted decisions。
5. active conflict 的 `proposal_ids` 包含该 key 下全部 pending proposal。
6. 已 resolved/dismissed conflict 不复用；后续新冲突创建新 id。
7. Patch 的 `base_context_revision` 与当前 revision 不一致时记录 `context_revision_mismatch` 事件；facts/risks/open questions/artifacts 可继续去重合并，keyed proposal 必须基于当前 proposal/conflict 重新检测，`obsolete_item_ids` 必须忽略，禁止旧 patch 删除新状态。

## 7. 局部阻塞

当 conflict 创建或更新时：

1. 读取当前 WorkflowRun。
2. 找到 `status === 'pending'` 且 `context_dependencies` 包含 conflict key 的 steps。
3. 将它们设为 `blocked`。
4. 把 conflict id 加入 `blocked_by_conflict_ids`。
5. 正在运行、已完成或无相关依赖的 step 不受影响。
6. WorkflowRun 本身保持 `running`，避免现有全局 gate guard 阻止无关工作。
7. 新计划的 step 在写入前也必须对 active conflicts 执行同一 blocker reconciliation。
8. Gate approval 和 conflict resolution 必须调用统一的 step blocker reconciliation；任何一方都不能直接把仍有另一类 blocker 的 step 改回 pending。

冲突解决后：

1. 从相关 steps 的 `blocked_by_conflict_ids` 移除 conflict id。
2. 仅当没有其他 conflict blocker、依赖已满足且没有 blocking gate 时恢复为 `pending`。
3. 已 skipped/completed/failed 的 step 不改写。

## 8. 解决权限

### Agent 可以

- 提交 proposal。
- 添加 evidence refs。
- 添加 risk/open question/artifact。
- 对已有 proposal 进行 critique，但不能直接 accepted。

### Commander 可以

- 将 conflict 切换为 gathering evidence / under review / awaiting user。
- 选择 proposal。
- merge 多个 proposal。
- reject 所有 proposal。
- 写入最终 accepted decision。

### 用户必须决定

- 明确用户偏好。
- 高风险或不可逆业务决策。
- 安全/权限冲突。
- Commander 无法在预算内根据证据解决的冲突。

## 9. 解决流程

```text
pending proposals
→ conflict detected
→ affected steps blocked
→ Commander chooses evidence/review/user path
→ resolve conflict
→ selected proposal accepted, others rejected/superseded
→ accepted decision written with reason and provenance
→ affected steps re-evaluated and resumed
```

非终态流转 API 支持：

```ts
{
  status: 'gathering_evidence' | 'under_review' | 'awaiting_user';
  updated_by: string;
  reason?: string;
  conflict_type?: ContextConflictType;
}
```

第一版 resolution API 接受：

```ts
{
  decision: 'accept' | 'reject' | 'merge';
  selected_proposal_ids: string[];
  text: string;
  resolved_by: string;
  reason?: string;
}
```

终态语义固定为：

- `accept`：必须选择恰好一个 proposal；该 proposal 变为 accepted，其他 proposal rejected，创建一条 accepted DecisionItem，conflict 变为 resolved。
- `merge`：必须选择至少两个 proposal；被选 proposal 变为 superseded（已被合并结果吸收），未选 proposal rejected，创建一条 merge 后的 accepted DecisionItem，conflict 变为 resolved。
- `reject`：`selected_proposal_ids` 必须为空；全部 proposal rejected，不创建 DecisionItem，conflict 变为 dismissed。

当 conflict 已是 `awaiting_user` 且 Commander turn 的可信来源消息来自用户时，resolution 记录 `resolved_by = user`；模型不能通过自由输入伪造决策者。其他情况记录 Commander。

## 10. Shared Context 投影

`buildSharedContextSummary` 增加：

- 最近 accepted decisions。
- 最近 agent output summaries。
- active conflicts 的 key、状态和 proposal 摘要。
- 对 blocked conflict 的明确指令：不要假定任何 pending proposal 已成为最终决定。

第一版仍使用同一结构化 summary 注入 Commander/Agent；按角色裁剪的 Step Context Projection 留到下一阶段。不得把完整 agent output 或大文件正文写入 summary，只写 compact summary 和 artifact ref。

## 11. P3394 关系

P3394 不保存 SharedTaskContext，只记录本次调用使用的协作引用：

- `workflow_run_id`
- `context_id`
- `context_revision`
- `conflict_ids`
- `step_id`（必须来自当前 QueueItem 的 `workflow_step_id`，不能从 active snapshot 猜测）

冲突核查使用：

- `query`：请求补充事实或证据。
- `negotiate`：要求回应相反 proposal 或形成修订。
- `delegate`：委派独立 Verification Agent。

Protocol Inspector 的 detail rows 展示 `workflow_run_id`、`context_id`、`context_revision`、`step_id` 和 `conflict_ids`，但不展开原始敏感上下文内容。

## 12. Renderer

Collaboration 抽屉的 Attention Needed 增加 conflict item：

```text
不同意见：market.entry_mode
2 个提案 · 等待 Orkas Agent 处理
```

第一版规则：

- 抽屉不提供 accept/reject/merge 按钮。
- `Open in chat` 回到主会话。
- 主会话负责 Commander 解释、核查和用户选择。
- 冲突解决后不再出现在 Attention Needed，可留在 Task Overview 的已解决摘要中。

## 13. IPC

增加只读和解决入口：

```text
GET  /api/conversations/:cid/collaboration/conflicts
POST /api/conversations/:cid/collaboration/conflicts/:conflictId/resolve
```

主进程 handler 必须只做参数校验并调用 group_chat feature facade。解决操作默认 `resolved_by = user`；未来 Commander tool 使用同一 feature function，不复制业务逻辑。

## 14. 错误与恢复

- 旧 context 缺少新字段时自动归一化，不破坏读取。
- proposal 引用不存在时 resolution 拒绝。
- conflict 已 resolved/dismissed 时重复 resolve 返回明确错误。
- 并发 patch/resolve 继续使用 conversation lock。
- context revision 不匹配的 Agent patch 第一版记录 warning event 并继续合并低风险字段；decision proposal 必须重新读取当前 active conflict 后合并。
- 应用重启后 active conflicts 和 blocked step 从 JSON 恢复。

## 15. 非目标

- 不实现自动无限 debate。
- 不使用多数投票。
- 不让 Agent直接写 accepted decisions。
- 不做跨会话全局 conflict dashboard。
- 不把 context 全文写入 P3394 protocol event。
- 不新增第二个“Controller Agent”。
- 不重建已移除的旧 plan DAG executor。

## 16. 成功标准

- 同一 conflict key 的不同 proposal 不再互相覆盖。
- 只有相关 pending steps 被阻塞。
- Commander/user 能通过统一 feature API 解决冲突。
- 解决记录包含最终文本、理由、来源和时间。
- 冲突解决后相关步骤可恢复。
- Shared Context summary 明确区分 pending proposal 与 accepted decision。
- P3394 event 带 workflow/context/conflict 引用，不泄露上下文全文。
- 协作概览能显示 active conflict，但审批仍在主会话。
