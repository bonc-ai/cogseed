# 能力册上下游接线契约 v0.1

> 状态：设计契约，尚未接线。本文只定义边界，不改动任何现有运行逻辑。
> 约束：不新建第三套 Schema；不重做已有列表页/详情页；上游能力（候选识别、Ontology 抽取、KSTAR 跨 Session 复用）留接口，不在能力册内重复实现。

全链路：

```
KSTAR evidence ──①──> RecallCandidate ──②──> RecallAbilityAssetRecord
                                                    │
                                              ③ 扩字段
                                                    │
                                    ④ context-projection ──> 跨 Session 复用
                                                    │
                                    ⑤ usage + proof ──> maturity 升阶
```

---

## ① 上游入口：evidence → RecallCandidate

### 源数据形状

PC 侧 `features/p3394/kstar-bus-integration.ts` 通过 `adapter.recordEvidence()` 发出四类记录，引擎 `record_evidence` 按 `id` 幂等收敛，`snapshot_export` 整体导出：

```ts
// tool_cycle
{ id, type: 'tool_cycle', conversation_id, agent_id, turn_id, tool_call_id,
  tool_name, phase: 'end', arguments_shape, result_preview, result_size,
  is_error, status: 'succeeded' | 'failed', verifier_method, duration_ms,
  created_at, boundary }

// agent_run_result（start / end 两相）
{ id, type: 'agent_run_result', conversation_id, agent_id, turn_id,
  phase, ...data, created_at, boundary }
```

`boundary` 由 `execution-boundary.ts` 注入，形如 `{ mode: 'real' | 'degraded', provider, reason? }`。

### 目标形状

`saveRecallCandidate(userId, input: SaveRecallCandidateInput)`：

```ts
interface SaveRecallCandidateInput {
  judgment: string;          // 必填，≤ 上限，boundedText 校验
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;   // personal | rule | template | skill_method
  suggestedScope: string;            // 必填字符串
  sourceRefs: unknown[];             // 归一化为 CognitionSourceRef[]
}
```

### 字段映射

| evidence 字段 | → | candidate 字段 | 处理 |
|---|---|---|---|
| `conversation_id` | → | `sourceRefs[].kind='conversation'` | 直接映射 |
| `id`（证据 id） | → | `sourceRefs[].kind='execution'` | 直接映射 |
| `tool_name` + `status` | → | `sourceRefs[].title` | 拼为 `tool_name · status` |
| `result_preview` | → | `sourceRefs[].excerpt` | **必须过 `redactSourceExcerpt()`**，它会脱敏 bearer/token/api_key 并截断到 240 字符 |
| `boundary.mode='degraded'` | → | `sourceRefs[].degraded=true` + `reason` | 降级证据要显式标注，不能当作可信来源 |
| — | → | `judgment` | **无法从证据推导，见下** |
| — | → | `suggestedType` | 见下 |
| — | → | `suggestedScope` | 见下 |
| — | → | `uncertainty` | 见下 |

`CognitionSourceKind` 白名单固定为：`memory / context / ontology / p3394_experience / p3394_patch / execution / conversation / artifact`。evidence 只映射到 `execution` 与 `conversation` 两种，不新增 kind。

### 缺失字段处理（关键设计决定）

`judgment` 是一句能力主张（"该做什么/怎么做更好"），**证据流里不存在这个语义**，只能由候选识别产出。

因此第一个 adapter 采取：**没有候选识别结果就不生成候选，而不是用模板拼一句假判断。** 理由是能力册的价值全部建立在 judgment 的可信度上，一旦允许机器拼凑，列表会被无意义条目淹没，用户确认动作随即失去意义。

各字段兜底策略：

| 字段 | 策略 |
|---|---|
| `judgment` | **不兜底**。缺失即不生成候选，adapter 返回 `{ skipped: 'no_judgment' }` |
| `suggestedType` | 默认 `skill_method`（证据来自工具执行链路，天然偏方法类）；候选识别可覆盖 |
| `suggestedScope` | 由 `agent_id` 推导为 `agent:<agent_id>`；无 agent_id 时用 `conversation:<conversation_id>` |
| `uncertainty` | 留空。降级证据（`boundary.mode='degraded'`）时写入固定说明，标明证据本身不可信 |

### 聚合口径

单条 evidence 不构成候选。adapter 的输入单位是**一次 agent run**（`conversation_id + agent_id + turn_id` 三元组），把该 run 下的全部 tool_cycle 聚合后交给候选识别。这与 `evidence_refs` 一对多的结构一致，也避免同一次执行产生多个重复候选。

---

## ② 候选交接：识别结果与用户确认

全部为**已存在**接口，adapter 只调用，不重写：

| 动作 | 服务层 | IPC |
|---|---|---|
| 新建候选 | `saveRecallCandidate(userId, input)` | `recall.candidates.save` |
| 修改候选 | `updateRecallCandidate(userId, candidateId, input)` | `recall.candidates.update` |
| 用户确认 → 生成资产 | `promoteRecallCandidate(userId, candidateId)` | `recall.candidates.promote` |
| 用户否决 | `rejectRecallCandidate(userId, candidateId, note?)` | `recall.candidates.reject` |
| 用户搁置 | `deferRecallCandidate(userId, candidateId, note?)` | `recall.candidates.defer` |
| 恢复搁置 | `resumeRecallCandidate(userId, candidateId)` | `recall.candidates.resume` |

候选状态机（现有，不改）：`pending → deferred → pending`、`pending → rejected`（终态）、`pending → promoted`（终态）。`promoteRecallCandidate` 对已 promoted 幂等返回，对 rejected 抛 `recall candidate is terminal`。

**去重责任在 adapter**：候选服务不按来源去重。adapter 必须在 `saveRecallCandidate` 前检查是否已存在覆盖同一 run 三元组的候选，否则重放 evidence 会造出重复候选。

---

## ③ 正式资产：扩字段

以 `RecallAbilityAssetRecord` 为准（`candidate-service.ts:44`），现有字段：

> **它是唯一的正式运行 Schema。** `features/p3394/ability-assets.ts` 里还有一套同名概念的
> `AbilityAsset`，已于 2026-08-06 标记 `@deprecated`：无任何生产调用方、不在
> `p3394/index.ts` barrel 里、只有测试还引用。它的每个字段在 recall 侧都有等价物
> （`scope` 对象 → `scope` 字符串 + `workspace-refs.ts`；`versions[]` / `audit[]` →
> 独立记录；`recommended_action` → `proof-service.ts::EffectivenessProofRecord
> .recommendedAction`；`evidence_refs` → `CognitionSourceRef`），**没有需要迁移的调用**。
> 落盘位置也不同（`local/kstar/ability-assets.json` vs
> `cloud/recall/records/ability-assets/`），两者不会争抢同一份文件。
> 尚未删除的原因见该文件头部注释。**任何一方都不要基于那套 P3394 类型写新代码。**

```ts
{ id, candidateId, type, title, statement, evidenceRefs, scope,
  status: 'active'|'paused'|'revoked',
  maturity: 'seed'|'bud'|'transfer_validated'|'effectiveness_validated',
  version: string, createdAt, updatedAt }
```

新增两个字段（向后兼容，读旧记录时为 `undefined`）：

```ts
confidence?: number;          // 0..1，两位小数
sourceSessionIds?: string[];  // 去重后的会话 id，上限 50
```

**写入点**：`promoteRecallCandidate()` 内构造 asset 处（`candidate-service.ts:279` 起，
asset 字面量在 `:290`）。

- `sourceSessionIds` ← 从 `candidate.sourceRefs` 中筛 `kind==='conversation'` 的 `id`，去重
- `confidence` ← 由候选识别给出并存在候选上；候选无该值时资产也不写，**不用默认值假装有置信度**

`evidenceRefs` 已由 promote 从 `candidate.sourceRefs` 继承，无需新增来源引用通道。

**版本历史与审计**：`listAbilityAssetVersions()` / `listAbilityAssetAudit()` 已存在且已由 `recall.assets.versions` 暴露。~~详情页当前未调用~~ —— **已于 N3/N4 接线完成**（`skills.js:180` 调 `recall.assets.versions`，`:188` 调 `recall.usage.list`）。P3394 那套 `AbilityAsset` 的 `versions[]` / `audit[]` 字段不再合并——recall 侧已用独立记录实现了同等能力，合并反而会造成双写。

**状态展示映射**（展示层，不改底层）：

| 底层 | 展示 |
|---|---|
| candidate `pending`/`deferred` | `candidate` |
| asset `active` + maturity `seed`/`bud` | `confirmed` |
| asset `active` + maturity `transfer_validated`/`effectiveness_validated` | `active` |
| asset `revoked` | `deprecated` |
| asset `paused` | `deprecated`（副标注"暂停"） |

---

## ④ 下游出口：跨 Session 复用

**已存在**，能力册不重复实现：

```ts
buildRecallView(userId, input): { assetIds, sourceRefs, omittedRefs }
previewContextProjection(userId, input): ContextProjectionRecord
confirmContextProjection(userId, projectionId)

interface ProjectionInput {
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  authorization?: 'user_confirmed' | 'workspace_policy' | 'not_required';
  expiresAt?: string;
}
```

投影状态：`preview → confirmed → expired | revoked`。`omittedRefs` 记录被排除的资产及原因，能力册详情页应当能展示"本次为何没用上"。

KSTAR 侧只需提供 `taskRunId` 与 `purpose`；**能力册不主动向 KSTAR 推送资产**，由 KSTAR 在派发前拉取投影。这条边界保证能力册不介入派发路径。

---

## ⑤ 反馈回流：使用记录、效果证据、成熟度

**全部已存在**：

```ts
recordRecallUsage(userId, {
  assetId, assetVersion, taskRunId,
  projectionId?, workspaceId?,
  boundary?: 'real' | 'degraded' | 'test-double',
  outcome?
})
listRecallUsage(userId, assetId?)          // IPC: recall.usage.list

prepareTransferProof(userId, { projectionId, executionId, expectedResultSnapshot })
completeTransferProof(userId, proofId, { status, receiptId?, observedTransfer })
evaluateEffectivenessProof(userId, { transferProofId, outcome, observedResult, evidenceRefs })

setAbilityAssetMaturity(userId, assetId, ...)
```

升阶链（现有语义）：

```
seed ──(transfer proof succeeded)──> transfer_validated
     ──(effectiveness proof outcome='better')──> effectiveness_validated
```

`EffectivenessProofRecord.recommendedAction` 已支持 `pause | narrow_scope | rework | rollback_to_version`，负向结果的处置路径不需要新建。

`boundary` 字段贯穿 usage 记录，`'test-double'` 用于标注 mock 产生的记录——**这正是 mock 边界的落地位置**，不需要额外发明标记机制。

---

## ⑥ 边界清单

### 真实已有，直接调用

| 段 | 接口 |
|---|---|
| 候选全生命周期 | `recall.candidates.{save,update,promote,reject,defer,resume,list,read}` |
| 资产读取与状态 | `recall.assets.{list,read,pause,revoke,versions}` |
| 使用记录 | `recordRecallUsage` / `recall.usage.list` |
| 效果证明与升阶 | `proof-service.*` / `setAbilityAssetMaturity` |
| 跨 Session 投影 | `context-projection.*` / `recall.projections.*` |
| 认知树 | `recall.tree.{read,rebuild}` |
| 引擎证据读写 | `record_evidence` / `snapshot_export`（本轮已修复并通过真进程验证） |
| 列表页 + 详情页 | `renderer/modules/skills.js` + `skills-bindings.js` |

### 需要新增

| # | 新增物 | 位置 | 说明 |
|---|---|---|---|
| N1 | evidence → candidate adapter | `features/recall/kstar-evidence-adapter.ts`（新） | 按 run 三元组聚合、映射 sourceRefs、去重、调 `saveRecallCandidate` |
| N2 | `confidence` / `sourceSessionIds` | `candidate-service.ts` | 扩两个可选字段 + promote 时写入 |
| N3 | 详情页接版本历史 | `skills.js` | 调已有 `recall.assets.versions` |
| N4 | 详情页接使用记录 | `skills.js` | 调已有 `recall.usage.list` |
| N5 | 状态展示映射函数 | `skills.js` | 按 ③ 的映射表，纯展示层 |

### 暂时 mock

| # | mock 项 | 边界标注方式 | 解除条件 |
|---|---|---|---|
| M1 | 候选识别（产出 judgment / confidence） | adapter 无识别结果时返回 `{ skipped: 'no_judgment' }`，**不造候选** | 接入真实识别（LLM 或规则引擎） |
| M2 | Ontology 抽取 | 不映射 `kind='ontology'` 的 sourceRef | 上游提供抽取结果 |
| M3 | 效果评估自动化 | 仅支持用户手动触发 `evaluateEffectivenessProof` | KSTAR DeltaR 语义化（文档 §5.5 #4） |
| M4 | 使用记录来自 mock 执行 | `boundary: 'test-double'` | 真实投影执行回流 |

**M1 是硬边界**：它决定了在候选识别接入前，这条链路只能"读得出证据、聚得出 run"，但**不会自动产生任何候选**。第一个 adapter 的验收标准因此是"聚合与映射正确 + 正确跳过"，而不是"能造出候选"。

---

## 下一步

第 4、5 步（Electron 启动 + evidence 跨重启存活）通过后，实现 N1，验收：

1. 给定一组真实 `record_evidence` 记录，adapter 能按 run 三元组正确聚合
2. `sourceRefs` 映射符合 ① 的表，`result_preview` 已脱敏
3. 无 judgment 时正确跳过且不写盘
4. 重放同一批 evidence 不产生重复候选
5. `npm run typecheck` + 对应测试通过
