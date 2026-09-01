# KSTAR 闭环问题详细解决方案

- 日期：2026-08-27
- 适用代码：`<repository-root>`
- 依据：KSTAR-Dashboard 消费审计、KSTAR 能力真实性审计、当前 develop 工作区代码核对
- 目标：把 KSTAR 从“可以记录执行结果的旁路模块”升级为“状态可验证、链路可追踪、失败可恢复、经验可复用、效果可证明的闭环治理系统”

> **Goal:** 修复 KSTAR 的身份、状态、结果和反馈四类断点，使任意 CogSeed 任务都能形成可恢复、可审计、可验证的 KSTAR 闭环。
>
> **Architecture:** 以 Main 进程为唯一治理边界，保留现有 JSON/JSONL 存储，通过统一生命周期契约、状态机、Execution Bridge、Trace façade、FailureRecord、InjectionReceipt 和 ValidationRecord 连接现有 KSTAR、Recall、group_chat 与 Runtime。
>
> **Tech Stack:** Electron Main/Renderer、TypeScript、现有 JSON/JSONL 存储与锁、IPC `window.cogseed` allow-list、现有 KSTAR/Recall/CogSeed Runtime 模块；不引入新数据库或新的 Renderer 构建链。

---

## 0. 结论先行

当前 KSTAR 的问题不是缺少 Task、Requirement、Projection、Forecast、Episode、Review、Candidate、Asset 这些对象，而是这些对象之间缺少四种连接：

1. **身份连接**：CogSeed 执行任务和 KSTAR 治理任务没有稳定的持久化 ID bridge。
2. **状态连接**：阶段失败、跳过、降级、超时没有统一、持久化的状态表达。
3. **结果连接**：ExtractionRun 没有回写真实 Candidate/Asset 结果，部分函数只有定义没有生产调用链。
4. **反馈连接**：经验被沉淀后，是否进入下一次执行、是否改善结果、是否应该升档或失效，没有完整证据。

因此解决方案不是继续添加更多 KSTAR 概念，而是围绕现有模块补齐一条**唯一、持久化、可恢复、可审计的主链路**。

目标链路：

```text
Task
  ↓
Requirement
  ↓
Projection
  ↓
Forecast
  ↓
Execution Bridge
  ↓
Episode
  ↓
Review
  ↓
ExtractionRun
  ↓
Candidate / Asset
  ↓
Injection Receipt
  ↓
Validation
  ↓
Promotion / Pause / Deprecation
```

其中每一段都必须具备：

```text
stage 状态 + 业务结果 + errorCode + degradedReason + provenance + idempotency
```

---

# 1. 解决目标与边界

## 1.1 必须达到的目标

### 目标 A：任务是否完成与 KSTAR 是否闭环完成分开表达

不能再只返回：

```text
任务完成
```

而要能表达：

```text
任务执行完成
KSTAR Episode 已生成
Review 已完成
ExtractionRun 部分完成
生成 2 个候选
其中 1 个资产已落盘
本次没有形成独立验证证据
```

### 目标 B：所有 KSTAR 阶段可以从任意入口追踪

从任意一个对象出发都可以找到其他对象：

```text
CogSeedTaskRecord
  ↔ kstarTaskId
  ↔ requirementId
  ↔ projectionId
  ↔ forecastId
  ↔ executionId
  ↔ episodeId
  ↔ reviewId
  ↔ extractionRunId
  ↔ candidateId / assetId
```

### 目标 C：失败必须成为可恢复的数据

任何阶段失败都必须回答：

- 哪个阶段失败；
- 失败发生在哪个对象；
- 是否已经重试；
- 是否可以继续执行；
- 是否影响任务结果；
- 是否允许进入经验沉淀；
- 重启后是否可以恢复。

### 目标 D：经验复用必须可证明

不能只证明“经验文件写出来了”，还必须记录：

```text
资产是否被当前任务选中
资产是否真正进入提示词
资产以什么模式进入：advisory / default / preferred
资产是否被执行过程读取
执行结果是否与这条资产关联
结果是否改善
```

### 目标 E：不让 KSTAR 的学习失败阻塞普通任务

执行链仍然保持可用，但必须从“静默放行”改为：

```text
允许执行 + 显式标记降级 + 持久化失败 + 可恢复重试
```

也就是说，Forecast 失败可以不阻塞普通执行，但不能再表现成“什么都没有发生”。

---

## 1.2 不做的事情

本方案明确不做以下事情：

1. 不引入新的数据库；继续使用现有 JSON/JSONL 和锁机制。
2. 不把 `kstar_control` 重新暴露成 Commander 的自由调用工具。
3. 不在 Renderer 定义 KSTAR 业务语义；Renderer 只展示 Main 返回的 DTO。
4. 不把 Forecast 缺失直接变成所有任务的硬阻断。
5. 不通过新增一个“大而全”的聚合文件替代现有 KSTAR 模块。
6. 不把一次自动生成的经验直接升为高成熟度资产。
7. 不把日志当作业务状态或闭环证据。

---

# 2. 当前问题对应的解决原则

| 当前根因 | 解决原则 |
|---|---|
| seed 升档自指循环 | 使用独立验证证据，注入本身不等于验证成功 |
| 失败只写日志 | 所有阶段失败写入持久化 FailureRecord 和失败 Receipt |
| `state.taskRun` 是内存粘合剂 | 把跨模块 provenance 写入 CogSeed Task 和 KSTAR Trace |
| 类型存在但生产链断裂 | 每项能力必须有生产调用点、消费点、结果回写和测试 |
| 状态词汇混乱 | 统一 stage/status/errorCode/degradedReason 四元契约 |
| Forecast/Projection 路径策略不一致 | 所有注入路径调用同一个 Runtime Gate |
| Candidate/Asset 结果不可反查 | ExtractionRun 记录真实 ID 和处理结果 |
| 没有跨任务验证 | 建立 InjectionReceipt、ValidationRecord、PromotionPolicy |
| 高风险操作全部自动确认 | Main 侧统一风险判断和确认策略 |

---

# 3. 目标架构

## 3.1 组件职责

```text
┌──────────────────────────────────────────────────────────┐
│ Main Process                                              │
│                                                          │
│  KSTAR Orchestrator                                      │
│  ├─ lifecycle/state-machine.ts                           │
│  ├─ trace-service.ts                                     │
│  ├─ failure-service.ts                                   │
│  ├─ control-service.ts                                   │
│  ├─ task-closure.ts                                      │
│  └─ learning-service.ts                                  │
│                                                          │
│  Execution Channels                                      │
│  ├─ group_chat/bus.ts                                    │
│  ├─ cogseed_backend/task-store.ts                        │
│  ├─ cogseed_runtime/protocol.ts                         │
│  └─ p3394 gateway                                        │
│                                                          │
│  Recall                                                   │
│  ├─ context-projection.ts                                │
│  ├─ formal-assets/runtime.ts                             │
│  ├─ prompt-injection.ts                                  │
│  └─ candidate/asset service                              │
└──────────────────────────────────────────────────────────┘
```

KSTAR 不直接实现每一种执行器，而是要求所有执行通道提供同一种执行桥：

```text
prepareKstarExecutionContext()
  ↓
startExecutionWithKstarProvenance()
  ↓
publishTerminalEventWithKstarProvenance()
```

这样 group_chat、Runtime、P3394、local CLI 都可以共享相同的 KSTAR 关联逻辑。

---

## 3.2 统一阶段契约

新增或集中定义：

```text
src/main/features/kstar/lifecycle-contract.ts
```

建议契约如下：

```ts
export type KstarStage =
  | 'routing'
  | 'projection'
  | 'forecast'
  | 'execution'
  | 'episode'
  | 'review'
  | 'extraction'
  | 'injection'
  | 'validation'
  | 'promotion';

export type KstarStageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'degraded'
  | 'cancelled'
  | 'timed_out';

export type KstarErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_confirmed'
  | 'not_applicable'
  | 'model_unavailable'
  | 'tool_unavailable'
  | 'workspace_unavailable'
  | 'persistence_failed'
  | 'validation_failed'
  | 'cancelled_by_user'
  | 'timed_out'
  | 'duplicate_event'
  | 'ownership_mismatch'
  | 'unknown';

export interface KstarStageReceipt {
  stage: KstarStage;
  status: KstarStageStatus;
  errorCode?: KstarErrorCode;
  degradedReason?: string;
  startedAt?: string;
  finishedAt?: string;
  retryCount: number;
  source: 'host' | 'runtime' | 'model' | 'user' | 'recovery';
  taskId?: string;
  requirementId?: string;
  executionId?: string;
  episodeId?: string;
  reviewId?: string;
  extractionRunId?: string;
  createdAt: string;
}
```

### 状态含义必须固定

| 状态 | 含义 |
|---|---|
| `pending` | 尚未开始 |
| `running` | 当前正在执行 |
| `succeeded` | 阶段成功完成 |
| `failed` | 阶段执行失败，未完成预期 |
| `skipped` | 根据明确策略主动跳过 |
| `degraded` | 结果可用但低于完整契约 |
| `cancelled` | 被用户或系统取消 |
| `timed_out` | 超过阶段允许的空闲/等待条件 |

禁止再用“没有记录”隐含表达 `skipped`、`failed` 或 `degraded`。

---

# 4. 核心数据模型改造

## 4.1 KSTAR Trace

新增：

```text
src/main/features/kstar/trace-types.ts
src/main/features/kstar/trace-service.ts
```

Trace 不重复存储所有业务对象，而是保存跨模块索引和阶段结果：

```ts
export interface KstarTraceRecord extends KstarJsonRecord {
  schemaVersion: 1;
  conversationId: string;
  taskId: string;
  requirementIds: string[];
  currentRequirementId?: string;

  executionIds: string[];
  episodeIds: string[];
  reviewIds: string[];
  extractionRunIds: string[];
  candidateIds: string[];
  assetIds: string[];

  projectionIds: string[];
  forecastIds: string[];

  stages: KstarStageReceipt[];
  learningStatus:
    | 'not_started'
    | 'candidate_created'
    | 'asset_created'
    | 'injected'
    | 'validated'
    | 'promoted'
    | 'paused'
    | 'deprecated';

  createdAt: string;
  updatedAt: string;
}
```

存储位置建议：

```text
<userCloudRoot>/<userId>/kstar/traces/<taskId>.json
```

Trace 的职责是提供稳定查询入口，不替代 Task、Episode、Review 等事实记录。

---

## 4.2 CogSeedTaskRecord 增加 KSTAR ID

修改：

```text
src/main/features/cogseed_backend/types.ts
src/main/features/cogseed_backend/task-store.ts
```

新增字段：

```ts
export interface CogSeedTaskRecord {
  // existing fields...
  kstarTaskId?: string;
  kstarRequirementId?: string;
  kstarProjectionId?: string;
  kstarForecastId?: string;
  kstarEpisodeId?: string;
  kstarReviewId?: string;
  kstarTraceId?: string;
}
```

要求：

1. 所有字段必须通过 `safeId` 校验。
2. 不允许从 user input 直接信任这些 ID。
3. 由 Main 根据当前 KSTAR 状态写入。
4. 不允许把 `project_id`、`uid` 编码进这些 ID。
5. 旧任务记录允许字段缺失，读取时向后兼容。

---

## 4.3 RuntimeRunRequest 增加可信 provenance

修改：

```text
src/main/features/cogseed_runtime/protocol.ts
src/main/features/cogseed_runtime/runtime-executor.ts
src/main/features/cogseed_runtime/worker-process.ts
```

新增：

```ts
export interface RuntimeKstarProvenance {
  taskId?: string;
  requirementId?: string;
  projectionId?: string;
  forecastId?: string;
  traceId?: string;
}

export interface RuntimeRunRequest {
  // existing fields...
  kstar?: RuntimeKstarProvenance;
}
```

安全要求：

- `kstar` 字段只允许 Main 生成；
- worker 不得修改或自行声明；
- worker 返回的终态事件必须原样带回，但 Main 要再次根据 TaskRecord 校验；
- Runtime 请求中缺少 Forecast 时仍可运行，但必须由 KSTAR 标记 `forecast: degraded` 或 `forecast: skipped`，不能让字段静默消失。

---

## 4.4 FailureRecord

新增：

```text
src/main/features/kstar/failure-types.ts
src/main/features/kstar/failure-service.ts
```

```ts
export interface KstarFailureRecord extends KstarJsonRecord {
  schemaVersion: 1;
  traceId?: string;
  taskId?: string;
  requirementId?: string;
  executionId?: string;
  episodeId?: string;
  stage: KstarStage;
  status: 'failed' | 'degraded' | 'cancelled' | 'timed_out';
  errorCode: KstarErrorCode;
  errorMessage: string;
  retryCount: number;
  recoverable: boolean;
  nextAction?: 'retry' | 'resume' | 'skip' | 'user_confirmation' | 'none';
  createdAt: string;
  updatedAt: string;
}
```

存储位置：

```text
<userCloudRoot>/<userId>/kstar/failures/<failureId>.json
```

错误信息必须经过长度限制和敏感信息过滤，不写入 token、文件秘密或完整用户私密内容。

---

# 5. 显式状态机与非法转换守卫

## 5.1 新增状态机模块

新文件：

```text
src/main/features/kstar/state-machine.ts
```

需要至少定义四组状态：

```text
Task：open → closing → closed
Task：open → abandoned
Requirement：open → waiting_review → closed
Requirement：open → abandoned
Episode：running → completed / failed / cancelled / timed_out
Review：inferred → needs_confirmation → confirmed
Review：inferred → unknown
Learning：not_started → candidate_created → asset_created → injected → validated → promoted
Learning：任何中间状态 → paused / deprecated
```

示例：

```ts
const TASK_TRANSITIONS: Record<KstarTaskPhase, readonly KstarTaskPhase[]> = {
  open: ['closing', 'abandoned'],
  closing: ['closed', 'abandoned'],
  closed: [],
  abandoned: [],
};

export function assertTaskTransition(
  from: KstarTaskPhase,
  to: KstarTaskPhase,
): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new KstarLifecycleError(
      'invalid_state_transition',
      `Task cannot transition from ${from} to ${to}`,
    );
  }
}
```

所有状态落盘前都必须调用守卫。禁止在 `control-service.ts`、`task-closure.ts`、`bus.ts` 中自行拼接状态跳转。

## 5.2 转换审计

每次状态变化必须写入：

```ts
export interface KstarTransitionAudit {
  entityType: 'task' | 'requirement' | 'episode' | 'review' | 'learning';
  entityId: string;
  from: string;
  to: string;
  reason: string;
  source: 'host' | 'runtime' | 'model' | 'user' | 'recovery';
  idempotencyKey?: string;
  createdAt: string;
}
```

重复事件不能造成重复状态转换；同一个 `idempotencyKey` 重放时必须返回原始结果。

---

# 6. 执行入口改造

## 6.1 统一任务入口

修改：

```text
src/main/features/group_chat/bus.ts
src/main/features/kstar/task-intent.ts
src/main/features/kstar/control-service.ts
```

所有真正的任务入口都必须经过：

```text
1. 识别或创建 KSTAR Task
2. 识别或创建 Requirement
3. 创建 Trace
4. 持久化 routing stage
5. 创建 Projection
6. 生成 Forecast
7. 绑定执行身份
8. 才允许派发执行
```

对于普通闲聊，明确写入：

```text
routing.status = skipped
routing.degradedReason = 'not_a_task'
```

不能通过没有 Task 记录来表示“这是闲聊”。

## 6.2 Projection 阶段

Projection 结果必须持久化：

```text
projection.pending
projection.running
projection.succeeded
projection.failed
projection.rejected
projection.degraded
```

当前 `workspace_policy` 自动确认仍可以保留，但需要接入风险策略：

```text
低风险：workspace_policy 自动确认
中风险：展示计划，允许继续
高风险：必须用户确认
```

风险判定必须在 Main 侧完成。Renderer 只接收：

```ts
interface KstarApprovalDecision {
  riskLevel: 'low' | 'medium' | 'high';
  required: boolean;
  reasons: string[];
  allowed: boolean;
}
```

---

# 7. Forecast 阶段改造

## 7.1 Forecast 不再只有“有/无”

修改：

```text
src/main/features/kstar/auto-forecast.ts
src/main/features/kstar/forecast-commit.ts
src/main/features/recall/world-model-types.ts
```

Forecast Record 增加：

```ts
export interface WorldModelForecastMetadata {
  forecastConfidence: number;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  contextFreshness: 'fresh' | 'stale' | 'unknown';
  forecastCreatedAt: string;
  generationStatus: 'succeeded' | 'failed' | 'skipped' | 'degraded';
  generationErrorCode?: string;
}
```

字段必须由 Main 根据实际状态生成，不能由模型自行宣称。

## 7.2 Forecast 缺失的处理策略

推荐策略：

```text
Forecast 失败
  ↓
写 forecast stage failure/degraded
  ↓
写 FailureRecord
  ↓
更新 Trace
  ↓
普通低风险任务：允许 advisory 执行
  ↓
高风险任务：禁止执行，要求重新生成或用户确认
```

不能再使用：

```text
forecast 失败 → catch → 空对象 → 正常执行
```

## 7.3 Snapshot 真实落盘

新增：

```text
src/main/features/recall/world-model-snapshot-store.ts
```

路径：

```text
<userLocalRoot>/<userId>/kstar/world-model-snapshots/<snapshotId>.json
```

Snapshot 至少记录：

- workspace 是否可用；
- 当前模型 profile；
- 实际可用工具集合；
- writable/read-only roots；
- Projection ID；
- 选中资产版本；
- 匹配的规则；
- 当前 Requirement 状态；
- Snapshot 创建时间。

`forecast-commit.ts` 禁止继续硬编码：

```ts
model: { configured: true }
tools: { fileSystem: true, bash: true }
```

这些值必须来自 Main 已验证的能力状态。

---

# 8. Execution Bridge 改造

## 8.1 所有执行通道写入同一组身份

修改：

```text
src/main/features/group_chat/bus.ts
src/main/features/cogseed_backend/task-store.ts
src/main/features/cogseed_backend/runtime-controller.ts
src/main/features/cogseed_runtime/protocol.ts
src/main/features/p3394_bridge/
```

在实际启动执行前调用：

```ts
const bridge = await bindKstarExecutionBridge({
  userId,
  conversationId,
  kstarTaskId,
  kstarRequirementId,
  projectionId,
  forecastId,
  traceId,
  executionId,
});
```

执行桥负责：

1. 更新 KSTAR execution stage 为 `running`；
2. 把 KSTAR ID 写入 CogSeedTaskRecord；
3. 把 provenance 写入 RuntimeRunRequest；
4. 记录执行开始时间；
5. 生成唯一 terminal event key；
6. 在执行结束时提交终态。

## 8.2 终态事件必须幂等

终态事件 key：

```text
<ownerId>:<executionId>:terminal
```

重复终态事件必须：

- 不重复创建 Episode；
- 不重复 Review；
- 不重复 Candidate；
- 返回第一次处理结果；
- 记录 duplicate_event，而不是再次执行闭环。

## 8.3 取消和超时必须分开

### 用户取消

```text
Execution → cancelled
Episode → cancelled
Requirement → abandoned 或 waiting_review
Task → abandoned 或 closing
Learning → 不允许强沉淀
```

### 超时

```text
Execution → timed_out
Episode → timed_out
Review → outcome=unclear，confidence 降低
Learning → 不允许强升档
```

### 工具失败

```text
Execution → failed
Episode → failed
Review → 根据证据判断 execution_gap / tool_gap
```

禁止把三者全部写成 `failed`。

---

# 9. Episode、Review、Closure 改造

## 9.1 Episode 持久化执行指标

修改：

```text
src/main/features/kstar/types.ts
src/main/features/kstar/episode-builder.ts
src/main/features/kstar/episode-store.ts
```

在 `episode.r` 中增加：

```ts
interface KstarExecutionMetrics {
  startedAtMs?: number;
  finishedAtMs?: number;
  durationMs?: number;
  toolCallCount: number;
  failedToolCount: number;
  cancelledToolCount: number;
  networkAccess: 'none' | 'used' | 'unknown';
  retryCount: number;
}
```

`startedAtMs` 和 `finishedAtMs` 不能只用于消息窗口过滤，必须落入 Episode。

## 9.2 Review 不能把失败伪装成成功

当前 `<repository-root>/src/main/features/kstar/task-closure.ts` 在 Review 推理失败时会写入保守 Review。调整为：

```text
Review 推理成功：review.status = succeeded
Review 推理失败但生成保守结果：review.status = degraded
Review 完全失败：review.status = failed，并写 FailureRecord
```

保守 Review 仍可用于展示，但默认禁止直接进入高置信度经验沉淀。

Review 增加：

```ts
export interface KstarReviewRecord {
  // existing fields...
  evidenceLayer: 'fact' | 'inference' | 'experience';
  reviewStatus: 'succeeded' | 'degraded' | 'failed';
  executionMetrics?: KstarExecutionMetrics;
  forecastUsed?: boolean;
  injectedAssetIds?: string[];
}
```

## 9.3 Closure 必须返回结构化结果

Closure 不能只抛异常或打日志。统一返回：

```ts
export interface KstarClosureResult {
  ok: boolean;
  status: 'completed' | 'degraded' | 'failed';
  episode?: KstarEpisodeRecord;
  review?: KstarReviewRecord;
  extractionRun?: KstarExtractionRunRecord;
  failureIds: string[];
  candidateIds: string[];
  assetIds: string[];
  degradedReasons: string[];
}
```

上层调用方必须消费这个结果并更新 Trace，不能丢弃返回值。

---

# 10. ExtractionRun 和经验沉淀改造

## 10.1 ExtractionRun 写真实结果

修改：

```text
src/main/features/kstar/task-closure.ts
src/main/features/kstar/task-level-precipitation.ts
src/main/features/kstar/direct-experience-assets.ts
src/main/features/kstar/recall-bridge.ts
```

当前 ExtractionRun 初始内容可能是：

```ts
candidateIds: []
status: 'created'
```

必须改成真实的阶段结果：

```ts
interface KstarExtractionRunRecord {
  candidateIds: string[];
  createdAssetIds: string[];
  mergedIntoIds: string[];
  updateCandidateIds: string[];
  status: 'created' | 'partial' | 'failed' | 'completed';
  error?: string;
  failureId?: string;
}
```

建议状态含义：

- `created`：ExtractionRun 已建立，但尚未执行沉淀；
- `completed`：提案、候选、资产结果已全部写回；
- `partial`：部分候选或资产处理成功；
- `failed`：沉淀过程失败，且没有形成可用结果。

## 10.2 不丢弃 `precipitateRequirementLevel` 返回值

调用方式必须从：

```ts
await precipitateRequirementLevel(userId, requirement);
```

改为：

```ts
const precipitation = await precipitateRequirementLevel(userId, requirement);
await updateExtractionRunFromPrecipitation({
  userId,
  requirement,
  result: precipitation,
});
```

写回内容必须包括：

```text
candidateIds
createdAssetIds
mergedIntoIds
updateCandidateIds
status
error
```

如果写回失败，还要生成 `persistence_failed` FailureRecord。

## 10.3 `proposeKstarCandidates` 的处理决策

必须二选一，不能继续保持“类型存在但调用链不清晰”：

### 推荐方案：保留并接入为 Episode 级提案器

调用链：

```text
Episode + Review
  ↓
proposeKstarCandidates
  ↓
Requirement 聚合器合并
  ↓
统一 Candidate Pool
```

这样 Episode 级和 Requirement 级不再互相覆盖，而是：

- Episode 级：提供细粒度证据；
- Requirement 级：负责跨 Episode 聚合和去重；
- Candidate Pool：负责统一生命周期和语义查重。

### 不推荐但可接受的方案：明确废弃

如果最终只保留 Requirement 级沉淀，则：

1. 删除生产无调用的函数；
2. 删除不再需要的类型引用；
3. 在迁移说明中明确不再提供 Episode 级候选；
4. 修改测试，验证 Requirement 级是唯一出口。

不能让函数长期处于“存在但无人调用”的状态。

---

# 11. 解决 seed 自指循环

## 11.1 统一注入策略

当前自动投影和已确认 Projection 的 Runtime Gate 语义不一致，必须统一为一个接口：

```ts
export type KstarInjectionMode =
  | 'manual'
  | 'automatic_advisory'
  | 'automatic_default'
  | 'preferred';
```

所有入口都调用：

```ts
evaluateAssetRuntimeEligibility(asset, {
  injectionMode,
  taskText,
  workspaceId,
  agentId,
});
```

禁止一个路径传 `silentDefaultInjection: true`，另一个路径传 `false` 后产生完全不同的业务语义。

## 11.2 推荐成熟度策略

推荐采用：

```text
seed：适用范围和安全边界通过后，可以以 automatic_advisory 方式注入
bud：满足独立验证计数后，可以 automatic_default
validated：经过稳定验证后，可以 preferred
```

关键规则：

```text
被注入 ≠ 验证成功
```

注入只生成 `InjectionReceipt`，不能单独触发成熟度升级。

## 11.3 InjectionReceipt

新增：

```text
src/main/features/recall/injection-receipt.ts
```

```ts
export interface InjectionReceipt {
  id: string;
  ownerId: string;
  taskId?: string;
  requirementId?: string;
  projectionId: string;
  executionId?: string;
  assetId: string;
  mode: 'manual' | 'automatic_advisory' | 'automatic_default' | 'preferred';
  enteredPrompt: boolean;
  selectedBy: 'user' | 'host' | 'semantic_selector';
  createdAt: string;
}
```

## 11.4 独立验证证据

新增：

```text
src/main/features/recall/validation-service.ts
```

```ts
export interface AssetValidationRecord {
  id: string;
  assetId: string;
  taskId?: string;
  episodeId?: string;
  injectionReceiptId?: string;
  result: 'positive' | 'neutral' | 'negative' | 'inconclusive';
  evidence: string[];
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  createdAt: string;
}
```

推荐升档规则：

```text
seed → bud：
- 至少 2 次跨任务 positive 验证；或
- 用户明确确认；或
- 外部验收证据通过

bud → effectiveness_validated：
- 至少 3 次跨任务 positive 验证；
- 没有连续失败；
- 适用范围一致；
- 没有重大安全边界冲突
```

推荐降级规则：

```text
连续 2 次 negative：paused
连续 3 次 negative：deprecated
环境变化导致规则失效：paused
来源失效或权限撤回：blocked
```

---

# 12. Provenance 完整构造

修改：

```text
src/main/features/kstar/task-level-precipitation.ts
src/main/features/kstar/extraction-service.ts
src/main/features/kstar/direct-experience-assets.ts
src/main/features/kstar/recall-bridge.ts
```

每条候选至少要带：

```ts
learningProvenance: {
  projectionId,
  forecastId,
  episodeId,
  ruleRefs,
  attribution,
  actionDelta,
  resultDelta,
}
```

构造规则：

1. `projectionId` 来自 Episode 或 Requirement 的真实关联，不能由模型猜。
2. `forecastId` 缺失时允许为空，但必须将 ExtractionRun 标记为 `degraded`。
3. `episodeId` 必须存在，否则不得进入 KSTAR 经验候选。
4. `ruleRefs` 只能来自 Forecast 实际使用的规则集合。
5. `attribution` 必须来自 Review，不由沉淀模块重新猜测。
6. 所有引用 ID 必须做 owner 校验。

---

# 13. 统一失败处理和 Receipt

## 13.1 修复 `persistReceipt`

修改：

```text
src/main/features/kstar/control-service.ts
src/main/features/kstar/control-types.ts
```

当前 Receipt 不能只接受成功结果，改为：

```ts
export interface KstarControlReceipt {
  idempotencyKey: string;
  inputHash: string;
  operation: KstarControlOperation | 'invalid';
  actor: 'host' | 'commander' | 'user' | 'recovery';
  status: 'ok' | 'rejected' | 'failed' | 'degraded';
  errorCode?: string;
  result?: KstarControlResult;
  createdAt: string;
}
```

所有路径都写 Receipt：

```text
成功 → ok
输入不合法/状态不允许 → rejected
持久化或内部执行错误 → failed
结果可用但不完整 → degraded
```

## 13.2 失败处理模板

所有 KSTAR 阶段采用同一模板：

```ts
try {
  await markStageRunning(...);
  const result = await operation();
  await markStageSucceeded(...);
  return result;
} catch (error) {
  const failure = await recordKstarFailure({
    stage,
    errorCode: classifyKstarError(error),
    errorMessage: safeErrorMessage(error),
    recoverable: isRecoverable(error),
    nextAction: nextActionFor(error),
  });
  await markStageFailed({ failureId: failure.id });
  return degradedOrFailedResult(failure);
}
```

禁止使用：

```ts
catch (error) {
  log.warn(...);
}
```

作为唯一错误处理。

## 13.3 自动关闭失败不能吞掉

修改：

```text
src/main/features/kstar/task-closure.ts
```

当前自动关闭调用中的 `.catch(() => undefined)` 必须改成：

```text
执行 auto-close
  ↓
成功：记录 finish receipt
失败：记录 closure failure
  ↓
设置 pending recovery
  ↓
启动恢复扫描
```

自动关闭失败不能继续让任务表现为“已闭环”。

---

# 14. Dashboard / IPC 可观测能力

## 14.1 新增只读 Trace IPC

修改：

```text
src/main/features/kstar/trace-service.ts
src/main/ipc/index.ts
src/main/preload.js
src/renderer/index.html
src/renderer/modules/
```

新增 IPC：

```text
kstar.trace.read
kstar.trace.list
kstar.failures.list
kstar.validation.list
```

Renderer 只能通过：

```text
window.cogseed.invoke('kstar.trace.read', { taskId })
```

读取，不能直接读 JSON 文件。

## 14.2 Trace 返回 DTO

```ts
export interface KstarTraceDto {
  task: {
    id: string;
    title: string;
    status: string;
  };
  requirements: Array<{
    id: string;
    status: string;
    episodeIds: string[];
  }>;
  stages: KstarStageReceipt[];
  executions: Array<{
    executionId: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
  learning: {
    candidateIds: string[];
    assetIds: string[];
    injectedAssetIds: string[];
    validationCount: number;
    status: string;
  };
  failures: KstarFailureRecord[];
}
```

Dashboard 至少能区分：

```text
未发生
已跳过
运行中
成功
降级
失败
取消
超时
```

---

# 15. 安全边界

## 15.1 所有 ID 必须验证

入口包括：

- IPC 参数；
- Commander 控制输入；
- Runtime provenance；
- Terminal event；
- Projection ID；
- Forecast ID；
- Candidate/Asset ID。

统一使用：

```text
safeId
ownerId 校验
路径 sandbox 校验
```

## 15.2 必须覆盖的恶意形状

新增测试：

```text
test/main/features/kstar/kstar-security-boundary.test.ts
```

至少覆盖：

1. `../other-user-record`；
2. 跨用户读取；
3. 空 ID、超长 ID、控制字符；
4. 伪造 projectionId；
5. 伪造 forecastId；
6. 伪造 executionId；
7. 重复终态事件；
8. 同一 idempotencyKey 不同 inputHash；
9. 越权调用高风险操作；
10. 损坏 JSON 单条记录不影响其他记录读取。

---

# 16. 详细实施顺序

## Wave 0：正确性发布门禁

### S1：统一契约和 FailureRecord

文件：

```text
新建：src/main/features/kstar/lifecycle-contract.ts
新建：src/main/features/kstar/failure-types.ts
新建：src/main/features/kstar/failure-service.ts
修改：src/main/features/kstar/control-types.ts
```

验收：

- 失败可持久化；
- stage/status/errorCode 可读取；
- 重启后失败记录仍存在；
- 不泄露敏感字段。

### S2：显式状态机

文件：

```text
新建：src/main/features/kstar/state-machine.ts
修改：control-service.ts
修改：task-closure.ts
修改：requirement-state.ts
```

验收：

- 非法状态转换抛出明确错误；
- 状态转换审计写入；
- 重复事件不重复转换。

### S3：修复控制 Receipt

文件：

```text
修改：control-service.ts
修改：control-types.ts
```

验收：

- 成功、拒绝、失败、降级都有 Receipt；
- 相同幂等键重复调用返回同一结果；
- 相同幂等键不同输入哈希被拒绝。

### S4：修复 ExtractionRun

文件：

```text
修改：task-closure.ts
修改：task-level-precipitation.ts
修改：direct-experience-assets.ts
```

验收：

- `candidateIds` 不再恒为空；
- `createdAssetIds` 真实回写；
- partial/failed 有明确状态；
- 沉淀错误有 FailureRecord。

### S5：补齐 timed_out 和执行指标

文件：

```text
修改：types.ts
修改：episode-builder.ts
修改：episode-store.ts
修改：review-inference.ts
```

验收：

- 超时不再被伪装成普通 failed；
- Episode 记录 durationMs；
- 超时任务不进入强经验升档。

### S6：安全测试和 Electron Smoke

文件：

```text
新建：test/main/features/kstar/kstar-security-boundary.test.ts
修改：test/smoke.ts 或现有 smoke 入口
```

Smoke 主链：

```text
创建 Task
→ 创建 Requirement
→ Projection
→ Forecast
→ 执行
→ Episode
→ Review
→ ExtractionRun
→ Candidate/Asset
→ Trace 查询
```

异常链：

```text
取消
超时
重复终态事件
重启恢复
沉淀失败
Forecast 失败
```

---

## Wave 1：持久化身份和可观测性

### S7：CogSeed/KSTAR ID bridge

文件：

```text
修改：cogseed_backend/types.ts
修改：cogseed_backend/task-store.ts
修改：cogseed_backend/runtime-controller.ts
修改：group_chat/bus.ts
修改：cogseed_runtime/protocol.ts
```

验收：

- 任意 CogSeed task 能找到 KSTAR task；
- 任意 KSTAR episode 能找到 execution；
- 重启后关联仍然可读。

### S8：Trace façade

文件：

```text
新建：kstar/trace-types.ts
新建：kstar/trace-service.ts
修改：ipc/index.ts
修改：preload.js
```

验收：

- Dashboard 不读 KSTAR 原始 JSON；
- 一次查询返回九层链路；
- 跨用户不可读；
- 损坏单条记录能降级读取。

### S9：统一 Projection/Forecast 路径

文件：

```text
修改：recall/formal-assets/runtime.ts
修改：recall/context-projection.ts
修改：recall/prompt-injection.ts
修改：kstar/forecast-commit.ts
```

验收：

- 自动投影和已确认投影使用同一 Gate；
- seed 使用策略一致；
- omitted reason 可查询；
- Forecast 缺失不再无声消失。

---

## Wave 2：真实学习闭环

### S10：InjectionReceipt

文件：

```text
新建：recall/injection-receipt.ts
修改：recall/prompt-injection.ts
修改：kstar/trace-service.ts
```

验收：

- 资产选中和进入提示词可区分；
- 注入模式可查询；
- 每次注入有唯一 receipt。

### S11：ValidationRecord 和 PromotionPolicy

文件：

```text
新建：recall/validation-service.ts
新建：recall/promotion-policy.ts
修改：recall/candidate-service.ts
修改：recall/asset-service.ts
```

验收：

- 2 次跨任务正向证据可以 seed→bud；
- 连续负向结果会暂停或废弃；
- 仅被注入不能升档。

### S12：完整 Provenance

文件：

```text
修改：kstar/extraction-service.ts
修改：kstar/task-level-precipitation.ts
修改：kstar/direct-experience-assets.ts
修改：kstar/recall-bridge.ts
```

验收：

- 每个 Candidate 可以反查 Projection、Forecast、Episode；
- `attribution` 与 Review 一致；
- 缺失 Forecast 的经验被标记 degraded。

### S13：Snapshot 落盘

文件：

```text
新建：recall/world-model-snapshot-store.ts
修改：kstar/forecast-commit.ts
修改：recall/world-model-types.ts
```

验收：

- Forecast 使用真实能力状态；
- Snapshot 可以查询；
- 旧 Forecast 兼容；
- Review 可以对照当时环境。

---

## Wave 3：高风险确认和运营化

### S14：风险分级确认

文件：

```text
新建：kstar/risk-policy.ts
修改：kstar/control-service.ts
修改：ipc/index.ts
修改：preload.js
修改：renderer KSTAR card 模块
```

验收：

- 低风险自动；
- 中风险展示计划；
- 高风险强制确认；
- Renderer 无法绕过 Main 判定。

### S15：指标和版本化

指标：

```text
任务完成率
KSTAR 闭环完成率
Forecast 成功率
Review 降级率
Extraction partial/failed 数
资产注入率
资产验证成功率
seed→bud 升档率
连续失败率
取消率
超时率
```

所有指标只记录 ID、类型、数量、长度和粗粒度状态，不记录用户内容。

---

# 17. 测试方案

## 17.1 单元测试

必须覆盖：

1. 状态机合法转换；
2. 非法转换拒绝；
3. `timed_out` 与 `failed` 区分；
4. FailureRecord 写入；
5. Receipt 成功/拒绝/失败/降级；
6. ExtractionRun 结果回写；
7. InjectionReceipt 幂等；
8. PromotionPolicy 升档和降级；
9. seed 在不同注入模式下的统一行为；
10. provenance 缺失时的 degraded 语义。

## 17.2 业务链测试

```text
completed execution
→ episode completed
→ review succeeded
→ extraction completed
→ candidate created
→ asset created
→ next projection selected
→ prompt entered
→ injection receipt created
→ positive validation
```

必须再跑：

```text
failed execution
cancelled execution
timed_out execution
review degraded
extraction partial
forecast unavailable
restart during closure
duplicate terminal event
```

## 17.3 Electron Smoke

真实 Electron 环境中验证：

1. Main 启动后 KSTAR orchestrator 已注册；
2. Renderer 只能通过 IPC 查询 Trace；
3. 任务正常执行并产生完整链路；
4. 关闭应用并重启后可恢复 pending closure；
5. 失败状态可在 Trace 中看到；
6. 高风险操作不能绕过确认；
7. 跨用户路径和越权 ID 被拒绝。

验证命令：

```bash
npm run typecheck
npm test
./run.sh
scripts/restart-cogseed.sh
```

---

# 18. 发布门禁

## 正确性门禁

- [ ] 非法状态转换全部拒绝；
- [ ] 超时有独立状态；
- [ ] 失败写入 FailureRecord；
- [ ] 失败写入 Receipt；
- [ ] ExtractionRun 记录真实结果；
- [ ] 重复终态事件不重复处理。

## 可观测门禁

- [ ] CogSeed Task 和 KSTAR Task 可互查；
- [ ] Trace 可返回完整阶段链；
- [ ] Projection/Forecast/Review/Extraction 状态可区分；
- [ ] Dashboard 不直接读业务 JSON；
- [ ] 重启后 Trace 仍可恢复。

## 学习闭环门禁

- [ ] Candidate 可反查 Episode 和 Review；
- [ ] Asset 可反查 Projection 和 Forecast；
- [ ] Asset 被注入有 InjectionReceipt；
- [ ] Asset 被验证有 ValidationRecord；
- [ ] 升档不依赖注入本身；
- [ ] 连续失败可以暂停或废弃资产。

## 安全门禁

- [ ] 跨用户访问拒绝；
- [ ] 路径穿越拒绝；
- [ ] 伪造 KSTAR ID 拒绝；
- [ ] Renderer 无权限定义 KSTAR 业务状态；
- [ ] 高风险操作必须经 Main 确认。

## 工程门禁

- [ ] `npm run typecheck` 通过；
- [ ] `npm test` 通过；
- [ ] Electron Smoke 通过；
- [ ] 旧 JSON 记录兼容读取；
- [ ] 不引入未经讨论的新 npm 依赖；
- [ ] macOS 和 Windows 关键路径分别验证。

---

# 19. 最终推荐实施顺序

最短关键路径如下：

```text
1. FailureRecord + 统一阶段契约
2. 显式状态机
3. Receipt 修复
4. ExtractionRun 真实回写
5. CogSeed/KSTAR ID bridge
6. Trace façade
7. Projection/Forecast Gate 统一
8. InjectionReceipt
9. ValidationRecord + PromotionPolicy
10. 风险分级确认
```

其中第 1～5 项是正确性基础，第 6～7 项是可观测基础，第 8～9 项才是真正的学习闭环，第 10 项是治理和安全增强。

不建议一开始就做 Dashboard UI 或复杂指标面板，因为如果底层状态、ID 和失败语义没有修好，Dashboard 只会把错误状态展示得更漂亮。

---

# 20. 一句话验收标准

> 对任意一个 CogSeed 任务，系统都能在重启后从任务入口查到 KSTAR Task、Requirement、Projection、Forecast、Execution、Episode、Review、ExtractionRun、Candidate、Asset、InjectionReceipt 和 ValidationRecord；任何一环失败都能明确显示失败阶段和恢复动作；只有当经验被真实使用并得到独立验证后，才允许升档。

这才算 KSTAR 从“能记录”升级为“真正闭环”。
