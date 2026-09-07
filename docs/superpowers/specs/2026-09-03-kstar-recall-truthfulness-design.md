# KSTAR / Recall 真实性闭环补齐设计

- 日期：2026-09-03
- 基线：`origin/develop`
- 实施路径：扩展现有 KSTAR / Recall 链路
- 明确排除：独立 Error Pattern 系统、`ErrorPatternAsset`、逐工具错误模式检索、Shadow Harness

## 1. 目标

在不增加平行系统、不引入依赖或数据库、不破坏旧数据读取的前提下，补齐四个缺口：

1. 区分资产被选中、可用、注入、实际采用和产生效果；
2. 将 Personal Ontology 与现有语义检索组成可审计的双路召回；
3. 强制跨 Agent 的 `ability_assets` 只能来自当前已确认 Projection；
4. 在现有 Review 中增加有证据约束的二级归因，而不是新增错误模式资产。

本设计不改变一个基本原则：KSTAR 学习失败可以显式降级，但不能阻断普通低风险任务；权限或版本校验失败必须 fail closed。

## 2. 非目标

本次不实现：

- 新的错误模式数据库、向量库或资产类型；
- 每次工具调用前查询历史错误；
- 用模型实时决定是否阻断工具调用；
- Error Pattern Shadow Mode；
- 新的 Renderer 页面或仪表盘；
- A2A 交接文档及 Creator / Agent Builder 功能；
- 对旧 JSON/JSONL 数据做破坏性迁移。

错误仍沿既有链路处理：

```text
Episode / Review
→ 证据约束的归因
→ 可复用性判断
→ personal / rule / template / skill_method Candidate
→ Validation / Promotion
```

## 3. 总体架构

本次只扩展现有责任边界：

```text
TaskContract
  ↓
Semantic candidates + Ontology candidates
  ↓
Runtime eligibility / scope / lifecycle / conflict gates
  ↓
Confirmed ContextProjection
  ↓
InjectionReceipt
  ↓
AssetUsageReceipt
  ↓
Episode + Review(primary attribution + secondary attribution)
  ↓
EffectivenessProof / Validation
  ↓
Candidate / Asset lifecycle
```

- `recall/` 负责检索、Projection、注入与使用事实；
- `group_chat/` 只在现有执行 chokepoint 提供 Host 可观察证据并执行授权校验；
- `kstar/` 负责 Episode、Review、归因与 Trace 汇总；
- IPC 和 Renderer 不承载新的业务判断。

## 4. 资产使用真实性

### 4.1 五层事实

资产流分为：

```text
Selected  → 已进入检索后的候选结果
Eligible  → 已通过确定性运行时门禁
Injected  → 已进入某个模型或 Agent 上下文
Applied   → Host 有证据证明执行采用了资产
Effective → 有结果证据说明采用后的效果
```

现有 `InjectionReceipt` 继续只表达 `injected/dispatched/omitted/failed`，不再承担 Applied 语义。

### 4.2 AssetUsageReceipt

在 Recall JSONL 存储中增加结构化使用收据：

```ts
type AssetUsageStatus =
  | 'applied'
  | 'considered_not_applicable'
  | 'available_no_opportunity'
  | 'contradicted'
  | 'usage_unknown';

interface AssetUsageReceipt {
  schemaVersion: 1;
  ownerId: string;
  id: string;
  taskRunId: string;
  projectionId: string;
  assetId: string;
  assetVersion: string;
  injectionReceiptId: string;
  status: AssetUsageStatus;
  evidenceRefs: CognitionSourceRef[];
  evidenceKind: 'tool_call' | 'agent_action' | 'artifact' | 'final_output' | 'none';
  boundary: 'real' | 'degraded' | 'test-double';
  reason?: string;
  createdAt: string;
}
```

幂等键由 `taskRunId + projectionId + assetId + assetVersion` 组成。同一执行重放更新同一事实，不累计重复收据。

### 4.3 Host 验证规则

本轮不增加让模型任意上报“我用了某资产”的新工具。Host 根据已有持久化事实保守判定：

1. 资产必须存在于当前执行的真实 `InjectionReceipt`；
2. 若 Episode 中存在对应资产引用，且存在成功 Tool Call、Agent Action、Artifact 或最终产物证据，则可记录 `applied`；
3. 只有注入、没有可关联执行证据时记录 `usage_unknown`；
4. 失败或取消的执行不能仅凭引用记录 `applied`；
5. `considered_not_applicable`、`available_no_opportunity`、`contradicted` 只接受未来结构化、可验证的 Host 输入；本轮存储和验证这些状态，但不从自然语言猜测生成；
6. `Effective` 继续由 `TransferProof + EffectivenessProof` 表达，不能从 Applied 自动推导。

这保证不会把 `injected`、`dispatched` 或模型自报误记为真实采用。

### 4.4 Trace

Trace 增加阶段：

```text
injection / usage / closure / candidate / trace_completeness
```

`trace_completeness` 只根据事实集合计算：

- `complete`：Projection、Injection、Usage、Episode、Review、Extraction 都有记录；
- `partial`：执行完成但一个或多个事实缺失；
- `not_recorded`：旧数据或未接入路径没有对应事实；
- `degraded`：有明确失败／降级记录。

界面未改造前，这些节点先通过现有 trace façade 提供给调用方。

## 5. 本体与语义双路召回

### 5.1 TaskContract

新增纯确定性轻量契约，不调用额外模型：

```ts
interface RecallTaskContract {
  goal: string;
  tokens: string[];
  objects: string[];
  actionType: 'analyze' | 'generate' | 'modify' | 'execute' | 'verify' | 'unknown';
  constraints: string[];
  requiredCapabilities: string[];
  ontologyAnchors: Array<{ groupId: string; field?: string; score: number }>;
}
```

契约从任务文本、purpose、workspace 和 T-Box 词汇中确定性提取。它只是检索查询结构，不写用户事实，也不能覆盖本轮明确指令。

### 5.2 本体候选

候选来源：

- 资产自身的 `ontologyRefs`；
- T-Box group title、field name 与任务 token 的规范化命中；
- R-Box subject/object 与任务 token 的命中；
- workspace 只加载当前 workspace 或全局规则。

本体匹配不绕过现有 `isAssetEligibleForProjection` 和 Runtime Gate。

### 5.3 合并与排序

`RecallAssetMatchMethod` 扩展为：

```text
semantic | ontology | semantic_ontology | recency_fallback | manual
```

排序规则：

1. 语义与本体都命中者优先；
2. 单路本体命中必须达到确定性锚点阈值；
3. 单路语义命中继续使用绝对阈值和相对阈值；
4. 同一资产合并成一条 match，不重复占 Top-N；
5. 保留现有类型多样性策略；
6. embedding 不可用时不把全部资产注入。本体有可靠命中则只保留本体候选；无可靠本体命中则返回空选择并显式 degraded；
7. 手工 Projection 仍可显式选择通过门禁的资产。

旧 Projection 的 `semantic/manual/recency_fallback` 继续兼容读取。

## 6. 跨 Agent Projection 子集强约束

### 6.1 权威 Projection

每次 `dispatch_to`、`hand_off_to`、正式 named worker 调用都必须在 Host 侧解析当前 KSTAR lifecycle，并取得：

- 当前 Requirement；
- Requirement 绑定的 Confirmed Projection；
- Projection 冻结的 `assetIds` 和 `assetVersions`。

### 6.2 校验顺序

```text
ability_assets 输入形状
→ 当前 Confirmed Projection 存在
→ requested ids ⊆ projection.assetIds
→ 冻结版本与当前资产版本一致
→ 资产 active
→ workspace / role / agent / purpose 运行时门禁
→ 结构化注入
```

任何一步失败都返回稳定、低敏错误码，不把 Projection 内容或其他资产 ID 泄露给模型。

匿名只读 worker 也不能获得 Projection 外资产。未传 `ability_assets` 时继续传递空集合。

### 6.3 兼容与降级

- 没有打开 KSTAR Requirement 的旧会话：显式传资产时拒绝；不传资产时正常执行；
- Projection 尚未确认：显式传资产时拒绝；
- Forecast 缺失不影响此授权判断；
- 授权失败不自动扩大或重建 Projection。

## 7. 二级归因

### 7.1 数据模型

保留现有一级 `KstarAttribution`，增加：

```ts
type KstarSecondaryAttribution =
  | 'task_interpretation_error'
  | 'recall_miss'
  | 'projection_omission'
  | 'injection_failure'
  | 'asset_not_applied'
  | 'asset_not_applicable'
  | 'asset_conflict'
  | 'asset_outdated'
  | 'execution_error'
  | 'environment_failure'
  | 'forecast_error'
  | 'permission_blocked'
  | 'user_goal_changed'
  | 'insufficient_evidence';

interface KstarAttributionDetail {
  category: KstarSecondaryAttribution;
  confidence: number;
  evidenceRefs: CognitionSourceRef[];
  source: 'deterministic' | 'model' | 'user';
}
```

Review 可选保存 `attributionDetails`。旧 Review 缺失该字段时正常读取。

### 7.2 决策优先级

确定性事实优先：

- Projection 没包含相关资产但检索审计显示候选 → `projection_omission`；
- InjectionReceipt 失败／缺失 → `injection_failure`；
- 注入成功但 Usage 为 unknown → `asset_not_applied` 或 `insufficient_evidence`，只有结构化证据足够才使用前者；
- 资产版本改变 → `asset_outdated`；
- Forecast stage 失败 → `forecast_error`；
- 稳定权限错误码 → `permission_blocked`；
- 网络、依赖、workspace 不可用 → `environment_failure`；
- 用户明确改变目标 → `user_goal_changed`；
- 没有足够证据 → `insufficient_evidence`。

模型只能在确定性事实没有结论时提出归因，且必须引用 Episode 已有 evidenceRefs；模型不能创造 evidence ID 或覆盖 failure code。

### 7.3 沉淀门禁

以下二级归因默认不生成通用资产：

```text
environment_failure
permission_blocked
user_goal_changed
insufficient_evidence
```

其他归因仍须通过现有语言、置信度、适用边界、重复检测和 Promotion 门禁，最终只进入四类现有资产。

## 8. 数据兼容与隐私

- 所有新字段为可选字段；旧 JSON/JSONL 不做重写；
- 所有 user-scoped 路径继续通过现有 Recall/KSTAR store；
- 所有引用 ID 使用 `safeId`；
- Usage Receipt 不写提示词全文、工具参数值或用户私密正文；
- evidence 只保存受支持的 `CognitionSourceRef`；
- 日志只记录 ID、状态、数量和脱敏错误；
- 不新增 Renderer 读取本地文件的能力。

## 9. 失败处理

- 使用收据写入失败：记录 KSTAR failure / Trace degraded，不覆盖任务成功状态；
- 本体读取失败：语义路径继续，标记 selection degraded；
- embedding 失败：只允许可靠本体候选；两路都不可用则空 Projection，不回退全量；
- Projection 子集或版本校验失败：本次资产派发 fail closed；任务可由 Commander 选择不带资产继续；
- 归因证据不足：落 `insufficient_evidence`，不生成候选；
- 重复终态或恢复重放：Usage Receipt、Review 和 Extraction 维持幂等。

## 10. 验收标准

### 使用真实性

- 注入资产但没有 Host 行为证据时只得到 `usage_unknown`；
- 成功执行且存在受信 Tool/Action/Artifact 证据时得到 `applied`；
- Applied 不自动等于 Effective；
- Trace 明确显示 injection、usage 和 completeness。

### 联合检索

- 纯语义匹配继续工作；
- 纯本体锚点可以召回相关资产；
- 双路命中合并成一条并优先排序；
- embedding 失败不会全量召回；
- workspace 外 R-Box 不参与锚点和 Forecast。

### 跨 Agent

- Projection 内且版本一致的资产允许派发；
- Projection 外资产拒绝；
- 未确认 Projection 拒绝；
- 版本漂移拒绝；
- 不传资产仍可正常派发。

### 归因

- 确定性错误码映射到正确二级归因；
- 每条二级归因都有证据和置信度；
- 无证据时只能是 `insufficient_evidence`；
- 环境、权限、目标变化和证据不足不生成通用资产。

### 回归

- 聚焦 KSTAR / Recall / Group Chat 测试通过；
- `npm run typecheck` 通过；
- `npm test` 完整通过；
- `git diff --check` 通过；
- 实机启动后 KSTAR 主链路无新增错误；
- 最终推送新分支，不直接推送 `develop`。

## 11. 分阶段交付

1. Usage Receipt 与 Trace 真实性节点；
2. TaskContract 与本体／语义双路召回；
3. 跨 Agent Confirmed Projection 子集校验；
4. 二级归因与沉淀门禁；
5. 聚焦回归、全量回归和实机验证。

每个阶段独立提交并保持测试可运行，避免把四项能力绑成一次不可审查的大提交。
