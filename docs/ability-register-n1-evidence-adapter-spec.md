# N1 · KSTAR evidence → RecallCandidate adapter 设计与测试规格 v0.1

> 状态：设计规格，**未接线**。不修改 KSTAR、candidate 生成或持久化逻辑。
> 前置：第 4、5 步（Electron 启动 + evidence 跨重启存活）通过后才实现。
> 上游契约见 [`ability-register-wiring-contract.md`](./ability-register-wiring-contract.md)。

---

## 1. 输入结构

### 1.1 四类 evidence（源自 `features/p3394/kstar-bus-integration.ts`）

| type | id 构成 | 关键字段 | 发出时机 |
|---|---|---|---|
| `tool_cycle` | `tool-{conv}-{agent}-{turn}-{toolCallId}` | `tool_name`、`status`、`is_error`、`result_preview`、`result_size`、`arguments_shape`、`duration_ms`、`verifier_method` | 每次工具调用结束 |
| `agent_run_result` | `run-start-{conv}-{agent}-{turn}` | `phase: 'start'`、`...data` | agent run 开始 |
| `conversation_message` | `contribution-{conv}-{agent}-{turn}-{messageId}` | `actual_action`、`actual_result`、`outcome_status`、`kstar_decision` | agent 产出贡献 |
| `collaboration_close` | `collab-{conv}-{commanderId}-{Date.now()}` | `commander_id`、`outcome_status: completed \| failed \| cancelled` | 协作收口 |

所有记录共有：`id`、`type`、`conversation_id`、`created_at`、`boundary`（`{ mode: 'real' \| 'degraded', provider, reason? }`，由 `execution-boundary.ts` 注入）。

### 1.2 两个必须在设计里正视的结构事实

**(a) `collaboration_close` 的 id 不稳定。** 它内嵌 `Date.now()`，同一次协作重复收口会产生不同 id，引擎侧的按 id 去重对它无效。因此：

- 它**不能**作为聚合键的一部分
- 它只作为「该 conversation 的一轮协作已结束」的**触发信号**
- adapter 自身的去重不能依赖它

**(b) `agent_run_result` 只有 start，没有 end。** 本文件里只有 `recordAgentRunStartEvidence`（`phase: 'start'`）。单个 agent run 的结束没有专门 evidence，收口信号在 conversation 级的 `collaboration_close`。所以 run 的「完成」判定只能来自协作收口，不能等一个不存在的 run-end。

**(c) `collaboration_close` 没有 `agent_id`**，只有 `commander_id`。它是 conversation 级事件，不属于任何 run 分组。

### 1.3 adapter 的输入形态

adapter 不订阅事件流，只接受**已落盘的 evidence 集合**（来自 `snapshot_export` 的 `evidence[]`），保持无状态、可重放：

```ts
interface EvidenceRecord {
  id: string;
  type: string;
  conversation_id?: string;
  agent_id?: string;
  turn_id?: string;
  created_at?: string;
  boundary?: { mode?: string; provider?: string; reason?: string };
  [key: string]: unknown;
}
```

---

## 2. 聚合键与去重规则

### 2.1 聚合键

```
runKey = `${conversation_id}::${agent_id}::${turn_id}`
```

三者缺一即**不参与聚合**（无法归属到一次具体执行）。`collaboration_close` 因缺 `agent_id`/`turn_id` 天然被排除，符合 1.2(c)。

一次 agent run 聚合成一个 `EvidenceRun`：

```ts
interface EvidenceRun {
  runKey: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  toolCycles: EvidenceRecord[];       // 按 created_at 升序
  contribution: EvidenceRecord | null; // conversation_message，取最后一条
  startedAt?: string;
  degraded: boolean;                   // 任一成员 boundary.mode !== 'real'
}
```

理由见契约 ①：单条 evidence 不构成候选。一次 run 内十几个 tool_cycle 若各自成候选，列表会被同一件事的碎片淹没。

### 2.2 三层去重

| 层 | 键 | 责任方 | 说明 |
|---|---|---|---|
| L1 引擎证据 | `evidence.id` | 引擎 `record_evidence` | 已实现，幂等；`collaboration_close` 除外（见 1.2a） |
| L2 run 聚合 | `runKey` | **adapter** | 同一 runKey 只产出一个候选输入 |
| L3 候选落库 | `fingerprint(judgment + sourceRefs)` | 现有 `saveRecallCandidate` | 已实现，相同指纹返回既有候选 |

**adapter 只负责 L2。** L1、L3 都已存在，不重复实现。

L2 的必要性：L3 的指纹基于 judgment 文本，而同一 run 在两次重放中若识别器给出措辞略异的 judgment，L3 会判为不同候选。L2 在调用 `saveRecallCandidate` 之前先按 runKey 查已有候选，挡住这种重复。

**L2 查重实现**：候选的 `sourceRefs` 中带一条 `{ kind: 'execution', id: runKey }`（见 §5），adapter 通过 `listRecallCandidates()` 匹配该 ref 判断是否已处理过。不新增索引文件、不新增持久化结构。

---

## 3. judgment 缺失时的跳过规则

`judgment` 是一句能力主张，evidence 流里不存在该语义（工具名、状态、耗时、结果预览都不是主张）。

**规则：没有可信 judgment 就不生成候选，不用模板拼。**

```ts
type AdapterOutcome =
  | { status: 'created'; candidateId: string; runKey: string }
  | { status: 'deduplicated'; candidateId: string; runKey: string }
  | { status: 'skipped'; runKey: string; reason: SkipReason };

type SkipReason =
  | 'no_judgment'        // 识别器未给出 judgment
  | 'incomplete_run'     // 缺 conversation_id / agent_id / turn_id
  | 'degraded_evidence'  // boundary.mode !== 'real'
  | 'no_evidence_refs';  // 归一化后 sourceRefs 为空
```

四条跳过理由都必须是**可观测的返回值**，不是静默丢弃 —— 否则无法回答「为什么这次执行没进能力册」。

`degraded_evidence` 单列的原因：降级执行的结果本身不可信，据此产出能力主张会把不可靠经验固化进能力册。

---

## 4. 脱敏与截断规则

| 字段 | 处理 | 上限 | 依据 |
|---|---|---|---|
| `result_preview` → `sourceRefs[].excerpt` | **必过 `redactSourceExcerpt()`** | 240 字符 | 该函数脱敏 `bearer`/`token=`/`api_key=` 及 JSON 内秘密值 |
| `tool_name` + `status` → `sourceRefs[].title` | `compactText` | 120 字符 | `MAX_TITLE_LENGTH` |
| `judgment` | 识别器给出，`boundedText` 校验 | 4000 | 现有 |
| `summary` / `uncertainty` | 同上 | 1000 | 现有 |
| `suggestedScope` | 同上 | 500 | 现有 |
| `sourceRefs` 条数 | adapter 截断 | 100 | IPC 上限 |

**`arguments_shape` 一律不进候选。** 它是参数结构，可能含文件路径、查询串等用户私有信息，而 `redactSourceExcerpt` 只针对已知密钥模式，覆盖不了。宁可少一层上下文，不冒泄露风险。

脱敏调用点在 adapter 内、写盘之前。`normalizeCognitionSourceRefs()` 已在 `saveRecallCandidate` 内做二次归一化，两层不冲突。

---

## 5. candidate 字段映射

```
EvidenceRun + RecognizerOutput → SaveRecallCandidateInput
```

| 目标字段 | 来源 | 缺失处理 |
|---|---|---|
| `judgment` | `recognizer.judgment` | **跳过整个 run**（§3） |
| `summary` | `recognizer.summary` | 省略 |
| `uncertainty` | `recognizer.uncertainty` | 省略；`degraded` run 已在 §3 跳过，不在此兜底 |
| `confidence` | `recognizer.confidence` | 省略（N2 已保证 absent 不伪造） |
| `suggestedType` | `recognizer.suggestedType` | 默认 `skill_method` |
| `suggestedScope` | `recognizer.suggestedScope` | 默认 `agent:{agentId}` |
| `sourceRefs` | 见下 | 空则跳过 |

`sourceRefs` 构成（顺序固定，便于指纹稳定）：

1. `{ kind: 'execution', id: runKey, title: 'run' }` — **L2 去重锚点，必有**
2. `{ kind: 'conversation', id: conversationId }` — 供 N2 的 `sourceSessionIds` 推导
3. 每条 tool_cycle → `{ kind: 'execution', id: evidence.id, title: '{tool_name} · {status}', excerpt: redact(result_preview), degraded?, reason? }`
4. contribution → `{ kind: 'conversation', id: messageId, excerpt: redact(actual_result) }`

超过 100 条时保留前 2 条锚点 + 按 `created_at` 最近的 tool_cycle，丢弃最旧的。

---

## 6. 测试矩阵

### 6.1 正常

| # | 场景 | 断言 |
|---|---|---|
| N-1 | 单 run,3 个 tool_cycle + 1 contribution,识别器给出 judgment | 产出 1 个候选;sourceRefs 含 runKey 锚点、conversation、3 条 tool、1 条 message |
| N-2 | tool_cycle 顺序打乱输入 | sourceRefs 按 `created_at` 升序;指纹稳定 |
| N-3 | 识别器给出 confidence 0.8125 | 候选 `confidence === 0.81` |
| N-4 | 识别器未给 suggestedType/Scope | 落为 `skill_method` / `agent:{agentId}` |

### 6.2 缺失

| # | 场景 | 断言 |
|---|---|---|
| M-1 | 识别器返回无 judgment | `{ status: 'skipped', reason: 'no_judgment' }`;**不写盘** |
| M-2 | evidence 缺 `turn_id` | `reason: 'incomplete_run'` |
| M-3 | 只有 `collaboration_close` | 不产生任何 run(缺 agent_id/turn_id) |
| M-4 | run 内无 tool_cycle 也无 contribution | `reason: 'no_evidence_refs'` |

### 6.3 重复

| # | 场景 | 断言 |
|---|---|---|
| D-1 | 同一批 evidence 跑两次 | 第二次 `status: 'deduplicated'`;候选总数不变 |
| D-2 | 同 run,第二次识别器给出措辞不同的 judgment | 仍 `deduplicated` —— L2 按 runKey 拦截,不依赖文本指纹 |
| D-3 | 引擎重放 pending 日志导致 evidence 重复出现 | 聚合后 tool_cycle 按 `evidence.id` 去重 |
| D-4 | 两个不同 run 产生相同 judgment | 产出两个候选(runKey 不同),不误合并 |

### 6.4 非法

| # | 场景 | 断言 |
|---|---|---|
| I-1 | `boundary.mode = 'degraded'` | `reason: 'degraded_evidence'` |
| I-2 | `result_preview` 含 `Authorization: Bearer xyz` | excerpt 中为 `[REDACTED]`,原值不出现在任何字段 |
| I-3 | `result_preview` 长 10000 字符 | excerpt ≤ 240 |
| I-4 | `arguments_shape` 含路径 | **不出现在候选任何字段** |
| I-5 | 单 run 含 300 条 tool_cycle | sourceRefs ≤ 100,含两条锚点 |
| I-6 | evidence 为 null / 数组 / 缺 type | 跳过该条,不抛异常中断整批 |
| I-7 | 识别器抛异常 | 该 run 跳过,其余 run 正常处理 |

### 6.5 跨 Session

| # | 场景 | 断言 |
|---|---|---|
| X-1 | 同 agent 在两个 conversation 各一次 run | 两个候选,各自 conversation ref 正确 |
| X-2 | 同 conversation 内两个 agent 并行 | 按 agentId 分成两个 run,互不混入 |
| X-3 | 同 agent 同 conversation 的两个 turn | 两个 run,turnId 区分 |
| X-4 | 候选 promote 后 | 资产 `sourceSessionIds` 含该 conversationId(N2 已实现,此处验证联通) |

---

## 7. 函数签名与拟修改文件

### 7.1 签名

```ts
// src/main/features/recall/kstar-evidence-adapter.ts（新增）

export interface EvidenceRun { /* §2.1 */ }

export type SkipReason =
  | 'no_judgment' | 'incomplete_run' | 'degraded_evidence' | 'no_evidence_refs';

export type AdapterOutcome =
  | { status: 'created'; candidateId: string; runKey: string }
  | { status: 'deduplicated'; candidateId: string; runKey: string }
  | { status: 'skipped'; runKey: string; reason: SkipReason };

/** 纯函数：把 evidence 集合聚合成 run，可单测，不触盘。 */
export function groupEvidenceIntoRuns(records: unknown[]): EvidenceRun[];

/** 纯函数：run → 候选输入；judgment 缺失返回 null。 */
export function buildCandidateInput(
  run: EvidenceRun,
  recognized: RecognizerOutput | null,
): SaveRecallCandidateInput | null;

/** 识别器接口 —— 本阶段留空实现，见 M1 边界。 */
export interface RecognizerOutput {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType?: AbilityAssetType;
  suggestedScope?: string;
  confidence?: number;
}
export type EvidenceRecognizer = (run: EvidenceRun) => Promise<RecognizerOutput | null>;

/** 唯一有副作用的入口：调用现有 saveRecallCandidate。 */
export async function ingestEvidenceRuns(
  userId: string,
  records: unknown[],
  recognizer: EvidenceRecognizer,
): Promise<AdapterOutcome[]>;
```

三个纯函数 + 一个副作用入口。前三个不碰磁盘，测试矩阵 §6 绝大部分只需纯函数。

### 7.2 拟修改文件

| 文件 | 性质 | 改动 |
|---|---|---|
| `src/main/features/recall/kstar-evidence-adapter.ts` | **新增** | 全部实现 |
| `test/main/features/recall/kstar-evidence-adapter.test.ts` | **新增** | §6 全矩阵 |
| `src/main/features/recall/index.ts` | 修改 | barrel 导出（一行） |

**不改**：`kstar-adapter.ts`、`kstar-bus-integration.ts`、`candidate-service.ts`、`asset-service.ts`、引擎任何文件、任何 IPC handler、任何渲染层文件。

adapter 只**读** evidence、只**调**现有 `saveRecallCandidate`。它不写 evidence、不改 KSTAR 状态机、不新增持久化结构。

### 7.3 本阶段的 mock 边界

`EvidenceRecognizer` 是注入参数，本阶段不提供生产实现：

- 测试注入桩识别器
- 生产接线（第 4、5 步之后）先注入**恒返回 null** 的识别器 → 全部 run 走 `skipped: 'no_judgment'`

这意味着首次真实接线的验收标准是「**聚合与映射正确 + 正确跳过**」，不是「能造出候选」。能力册在真实识别器接入前不会自动新增任何条目 —— 这是契约 M1 定的硬边界，本规格不放宽。
