# 能力册上下游联调清单 v0.1

> 用途：交给上下游对齐用。说明本轮解决了什么、统一了哪些字段、各方后续需要改什么。
> 责任人依据 2026-08-06 会议分工：
> 1. 候选认知资产识别（实时识别 / 用户圈选 / 夜间识别）—— 陈万康
> 2. 候选认知资产确认 —— 陈万康
> 3. 认知资产沉淀与管理（能力资产列表 / 认知树 / 使用记录）—— 史雨萱 ← **本文档交付方**
> 4. 基于 KSTAR 的认知资产复用 —— 张照航
> 5. 本体信息抽取设计 —— 张浩
> 6. 未注册场景「60秒旅程」整体设计 —— 刘婷婷
>
> `docs/README.md` §4.3 的旧 Sprint 2 名单（冯静雯 / 牛保康 / 吴嘉宇）已不适用；
> 原属该名单、新分工未覆盖的引擎内部条目标注为「待重新指派」。
> 相关文档：[接线契约](./ability-register-wiring-contract.md) · [N1 规格](./ability-register-n1-evidence-adapter-spec.md)

---

## 0. 一句话结论

**PC↔Engine 的证据通道此前是断的**——PC 调用的三个工具引擎一个都没有，所有 KSTAR 证据静默堆积在 `pending-evidence.jsonl` 永不回放。本轮把通道打通并加了持久化与恢复，同时把能力册详情页接上了已有但未使用的版本/使用记录接口。

**尚未打通的是候选识别**：证据流里不存在「能力主张」这个语义，没有识别器就不会产生任何候选。这是当前唯一的硬阻塞。

---

## 1. 本轮已解决（可交付）

| # | 问题 | 现状 | 验证方式 |
|---|---|---|---|
| S1 | 引擎缺 `snapshot_import` / `snapshot_export` / `record_evidence` | 已实现并注册（工具数 26 → 29） | 真进程 MCP 探针 + 7 个端到端用例 |
| S2 | 证据只在引擎内存，进程退出即丢 | `record_evidence` 回传快照，PC 落盘 | PC 侧用例 |
| S3 | 引擎重启后状态为空，首条证据会覆盖用户全部历史 | 握手时从磁盘 hydration；导入失败保持 degraded | 3 个用例 |
| S4 | 快照损坏无法察觉 | sha256 完整性校验，不符即拒绝导入 | 篡改/截断用例 |
| S5 | 资产缺 `confidence` / `sourceSessionIds` | 已扩字段，向后兼容 | 8 个用例（含旧格式记录） |
| S6 | 详情页不显示版本历史 / 使用记录 | 接已有 `recall.assets.versions`、`recall.usage.list` | 15 个用例 |
| S7 | 状态语义分散（候选态 + 资产态 + 成熟度） | 展示层映射为七态枚举，底层不动 | 23 个用例 |
| S8 | evidence → run 聚合无实现 | N1 纯函数层完成（未接线） | 35 个用例 |

改动文件见 §6。PC 侧 6217 通过 / 11 跳过，引擎侧 86 通过（20 文件），`tsc --noEmit` 零错误。

> **另有 4 个失败**，全在 `test/main/features/group_chat/bus-integration.test.ts`，
> 与本轮任何源码改动无关，是一个此前未被发现的**测试环境依赖**——见 §4 B9。

---

## 2. 接口逐条清单

### 2.1 引擎侧：KSTAR 快照三件套

| 项 | 内容 |
|---|---|
| **责任人** | 本轮由史雨萱交付；引擎侧遗留问题归张照航（B4 / B7），B5 待指派 |
| **实现位置** | `packages/nseap-meta-skill-engine/src/index.ts` + `src/persistence/kstar-state.ts` |
| **状态** | ✅ 已实现 |

**`snapshot_import`**

| 方向 | 字段 |
|---|---|
| 入 | `snapshot?: object`（省略 = 重置为空） |
| 出 | `{ success, generation, evidence_count }` / 失败 `{ success: false, error }` |

**`snapshot_export`**

| 方向 | 字段 |
|---|---|
| 入 | 无 |
| 出 | `{ success: true, snapshot: KstarStateSnapshot }` |

**`record_evidence`**

| 方向 | 字段 |
|---|---|
| 入 | `{ id (必填), type?, ...任意字段 }` |
| 出 | `{ success, deduplicated, generation, snapshot }` |

**快照结构**（引擎持有，PC 视为不透明）：

```
{ schema_version: 1, generation, snapshot_hash (sha256), evidence[], created_at, updated_at }
```

**⚠️ 需要张照航确认的两点：**

1. **命名分歧**：`src/persistence/tool-catalog.ts` 里有个 `add_evidence`，参数是
   `{ skill_id, base_generation, evidence }`，与 PC 实际调用的 `record_evidence` 不同名也不同形。
   **该 catalog 从未挂到 MCP server 上，是死代码**（`getToolCatalog()` 无任何运行时引用，
   只有一个测试断言它有 13 个工具）。本轮按 PC 实际调用实现了 `record_evidence`，
   未动那份 catalog。**请确认是删除死代码还是有其它计划**——两套并存会让后来者困惑。
2. **完整性哈希**：新增的快照用 sha256，未复用 `canonical-json.ts::stableHash`。
   后者是 32 位非加密哈希，而 CAS 循环靠它判断快照是否损坏，碰撞概率过高。
   规范化 key 排序仍复用其逻辑，跨进程确定性不变。

### 2.2 PC 侧：证据适配器

| 项 | 内容 |
|---|---|
| **责任人** | 史雨萱（已交付） |
| **实现位置** | `src/main/features/p3394/kstar-adapter.ts` |
| **状态** | ✅ 已实现 |

| 方法 | 入 | 出 | 说明 |
|---|---|---|---|
| `initialize()` | — | — | 握手 + 协议版本检查 + **磁盘快照 hydration** |
| `recordEvidence(evidence)` | 见 §2.3 | `{ success, deduplicated?, degraded?, boundary }` | 成功且非去重时落盘 |
| `runCasTransaction(mutator)` | — | `{ success, result?, error? }` | import → mutate → export → 落盘 |

**行为约定（下游需知）**：快照存在但导入失败时，适配器**保持 degraded 而不继续**，
证据进 pending 日志。这是有意为之——继续会让后续写入用局部状态覆盖读不出来的快照。

### 2.3 证据发射端

| 项 | 内容 |
|---|---|
| **责任人** | 张照航（KSTAR 认知资产复用，消费同一批证据） |
| **实现位置** | `src/main/features/p3394/kstar-bus-integration.ts` |
| **状态** | ✅ 已有实现，⚠️ 有两处结构问题 |

| type | id 构成 | 关键字段 |
|---|---|---|
| `tool_cycle` | `tool-{conv}-{agent}-{turn}-{toolCallId}` | `tool_name` `status` `is_error` `result_preview` `result_size` `arguments_shape` `duration_ms` `verifier_method` |
| `agent_run_result` | `run-start-{conv}-{agent}-{turn}` | `phase: 'start'` + 自定义 `data` |
| `conversation_message` | `contribution-{conv}-{agent}-{turn}-{messageId}` | `actual_action` `actual_result` `outcome_status` `kstar_decision` |
| `collaboration_close` | `collab-{conv}-{commander}-{Date.now()}` | `commander_id` `outcome_status` |

共有字段：`id` `type` `conversation_id` `created_at` `boundary`

**⚠️ 需要张照航确认的两点：**

1. **`collaboration_close` 的 id 内嵌 `Date.now()`，不稳定。**
   同一次协作重复收口产生不同 id，**引擎的按 id 幂等去重对它完全无效**，
   重放会不断堆积。建议改为稳定 id（如 `collab-{conv}-{commander}-{runSeq}`）。
   在此之前，能力册 adapter 把它排除在聚合键之外，只当收口信号用。
2. **`agent_run_result` 只有 start，没有 end。**
   单个 agent run 的结束没有专门证据，收口信号只在 conversation 级。
   协议层改造为控制器型时，建议补 run 级结束事件——否则「一次执行是否完成」
   只能从 conversation 级事件间接推断。

### 2.4 能力册：候选服务

| 项 | 内容 |
|---|---|
| **责任人** | 史雨萱（已交付） |
| **实现位置** | `src/main/features/recall/candidate-service.ts` |
| **状态** | ✅ 已实现（本轮扩字段） |

| IPC | 入 | 出 |
|---|---|---|
| `recall.candidates.save` | `judgment*` `summary` `uncertainty` `suggestedType*` `suggestedScope*` `sourceRefs*` **`confidence`（新）** | `{ ok, candidate }` |
| `recall.candidates.update` | 同上 + `candidateId*` | `{ ok, candidate }` |
| `recall.candidates.promote` | `candidateId*` | `{ ok, candidate, asset }` |
| `recall.candidates.{defer,resume,reject}` | `candidateId*` `note` | `{ ok, candidate }` |

**新增字段语义（各方必须遵守）：**

- **`confidence`**：0..1，两位小数。**缺失即 absent，不写默认值。**
  非法值（NaN / >1 / <0 / 字符串）**抛错，不强转**。
  编辑 judgment 而未带 confidence 时，旧分数被清除——它描述的是旧判断。
- **`sourceSessionIds`**：promote 时由候选 `sourceRefs` 中 `kind==='conversation'`
  的 id 推导，首次出现顺序去重，上限 50。无会话来源则整个字段不写。

### 2.5 能力册：资产、版本、使用记录

| 项 | 内容 |
|---|---|
| **责任人** | 史雨萱（已交付）—— 对应分工第 3 项 |
| **状态** | ✅ 已接通 |

| IPC | 入 | 出 | 本轮改动 |
|---|---|---|---|
| `recall.assets.list` | — | `{ ok, assets }` | 资产新增两字段 |
| `recall.assets.read` | `assetId` | `{ ok, asset }` | 同上 |
| `recall.assets.versions` | `assetId` | `{ ok, versions, audit }` | **详情页接入** |
| `recall.usage.list` | `assetId?` | `{ ok, usage }` | **详情页接入** |
| `recall.assets.{pause,revoke}` | `assetId` `note?` | `{ ok, asset }` | 无 |

**版本与审计保持独立事实源**，未内嵌进资产记录——避免双写。

### 2.6 展示状态映射

| 项 | 内容 |
|---|---|
| **责任人** | 史雨萱（已交付） |
| **实现位置** | `src/renderer/modules/ability-asset-status.js` |
| **状态** | ✅ 已实现（纯函数，不落盘） |

底层三套状态词表**一字未改**，仅在展示层映射：

| 底层 | 展示枚举 |
|---|---|
| candidate `pending` / `candidate` | `candidate` |
| candidate `deferred` | `candidate` + note `deferred` |
| candidate `rejected` | `rejected` |
| candidate `promoted` / asset `active` + maturity `seed`/`bud` | `confirmed` |
| 同上 + maturity `transfer_validated`/`effectiveness_validated` | `active` |
| asset `paused` | `paused` |
| asset `revoked` | `deprecated` |
| 其它任意组合（含 promoted 但资产不可解析） | `unknown` |

**不猜测**：无法识别的组合一律返回 `unknown`，不给乐观兜底值。

### 2.7 N1 证据聚合（纯函数层）

| 项 | 内容 |
|---|---|
| **责任人** | 聚合层：史雨萱（已交付）· 识别器：**陈万康**（未实现） |
| **实现位置** | `src/main/features/recall/kstar-evidence-adapter.ts` |
| **状态** | 🟡 纯函数已实现，**未接线** |

| 函数 | 入 | 出 |
|---|---|---|
| `groupEvidenceIntoRuns(records)` | `unknown[]` | `{ runs, closes, unattributed }` |
| `buildCandidateInput(run, recognized)` | `EvidenceRun` + `RecognizerOutput \| null` | `{ ok: true, input }` / `{ ok: false, reason }` |
| `runAnchorRef(runKey)` | `string` | `CognitionSourceRef` |

**聚合键**：`conversation_id::agent_id::turn_id`，三者缺一不成 run。

**四种跳过原因**（结构化返回，非静默丢弃）：
`no_judgment` · `incomplete_run` · `degraded_evidence` · `no_evidence_refs`

### 2.8 下游：跨 Session 复用与效果回流

| 项 | 内容 |
|---|---|
| **责任人** | 张照航（KSTAR 复用 + DeltaR 语义化 B7） |
| **状态** | ✅ 服务层已存在，🔴 未与能力册联调 |

| 接口 | 入 | 出 |
|---|---|---|
| `recall.projections.preview` | `taskRunId*` `workspaceId` `purpose*` `authorization` `expiresAt` | `{ ok, projection }` |
| `recall.projections.confirm` | `projectionId*` | `{ ok, projection }` |
| `recall.usage.list` | `assetId?` | `{ ok, usage }` |
| `recall.proofs.transfer.prepare` | `projectionId*` `executionId*` `expectedResultSnapshot*` | `{ ok, proof }` |
| `recall.proofs.effectiveness.evaluate` | `transferProofId*` `outcome*` `observedResult*` `evidenceRefs*` | `{ ok, proof }` |

**能力册不主动向 KSTAR 推送资产**，由 KSTAR 在派发前拉取投影。这条边界保证能力册不介入派发路径。

---

## 3. 统一字段约定（各方需遵守）

| 字段 | 约定 | 违反后果 |
|---|---|---|
| `boundary` | 每条 evidence 必带 `{ mode: 'real' \| 'degraded' }` | **缺失按 degraded 处理**，该次执行不会产生候选 |
| `boundary`（usage 记录） | `real` / `degraded` / `test-double` | 非 `real` 在详情页显式标注，避免 mock 被当证据 |
| `confidence` | 缺失即 absent；非法值抛错 | 伪造默认值会让用户误以为系统有把握 |
| `sourceRefs.kind` | 仅限白名单 8 种 | 非白名单 kind 被 `normalizeCognitionSourceRefs` 静默丢弃 |
| `sourceRefs.id` | 必须匹配 `[A-Za-z0-9_-]+` | **否则整条 ref 被静默丢弃**（`safeId` 规则） |
| run anchor ref id | `run-<sha256(runKey) 前16位>` | 要与能力册关联 run 的一方必须用同一算法 |
| evidence id | 必须稳定可重放 | 不稳定 id 使引擎幂等去重失效（见 §2.3 问题 1） |

> `sourceRefs.id` 那条是个真实陷阱：runKey 用 `::` 分隔，直接当 ref id 会被
> `safeId` 拒绝并**静默丢弃**，锚点消失且不报错。所以锚点用 sha256 摘要，
> 可读三元组放在 `title` 里。任何需要构造 ref 的一方都要注意这条。

---

## 4. 阻塞清单

| # | 阻塞项 | 责任人 | 影响 | 严重度 |
|---|---|---|---|---|
| B1 | **候选识别器无实现** | **陈万康**（第 1 项） | 无 judgment 就不产生任何候选，能力册不会自动新增条目 | 🔴 硬阻塞 |
| B2 | `collaboration_close` id 不稳定 | 张照航（第 4 项） | 引擎去重失效，重放堆积 | 🟠 |
| B3 | `agent_run_result` 无 end 相 | 张照航（第 4 项） | run 完成只能间接推断 | 🟠 |
| B4 | 死代码 `tool-catalog.ts` 与实现命名分歧 | 张照航 | 后来者困惑，可能重复实现 | 🟡 |
| B5 | ~~serverInfo 版本 `0.1.0` ≠ package.json `1.0.0`~~ | 史雨萱 | ✅ **已修复**：`engine_version: '1.0.0'`，三处统一并加测试锁住 | ✅ |
| B6 | Ontology 抽取未接 | **张浩**（第 5 项） | `kind: 'ontology'` 的 sourceRef 不产生 | 🟡 |
| B7 | DeltaR 仅字符串相等 | 张照航 | 效果评估无法自动化 | 🟠 |
| B8 | 真机验证：启动+握手 ✅ / 跨重启 ❌ | 史雨萱（第 3 项） | S3 hydration 的生产路径仍未确认 | 🟡 |
| B9 | **bus-integration 测试依赖「引擎未编译」** | 待指派 | 任何跑过 `run.sh` 的机器上 4 个用例必失败 | 🟠 |

**B1 是决定性的**：它没解决之前，整条链路只能「读得出证据、聚得出 run」，
但**不会自动产生任何候选**。N1 首次接线的验收标准因此是
「聚合与映射正确 + 正确跳过」，不是「能造出候选」。

**B8 说明**（2026-08-06 更新）：首启的网络阻塞已解除（见
[首启网络指南](./first-run-network-guide.md)），真实 Electron 应用已成功启动，
应用日志确认握手成功：

```
(p3394.kstar-adapter) engine handshake ok { engineVersion: '1.0.0', protocol: '1.0' }
(p3394.kstar-factory) engine adapter initialized
```

**仍未验证的是跨重启存活。** `<container>/data/<uid>/local/kstar/` 目录此刻尚未生成——
应用起来后没有任何 agent 活动产生证据，adapter 握上手但还没写过盘。关闭 B8 需要：
在应用内真实跑一次协作产生证据 → 确认 `snapshot.json` 落盘 → 重启 → 确认 hydration
把状态读回来。在此之前 S3 仍应视为「测试环境已验证、生产路径待确认」。

**B9 说明**：`bus-integration.test.ts` 里 4 个 KSTAR 用例断言证据出现在
`pending-evidence.jsonl`，而那是**引擎不可用时的 degraded 路径**才写的文件。
`kstar-factory.ts::defaultEngineConfig()` 默认把引擎指向
`<engineDir>/dist/index.js`——该文件不存在时 spawn 失败、退化成 degraded，
测试通过；一旦引擎被编译出来（`run.sh` 每次启动都会编译），证据直接进引擎，
pending 日志为空，4 个用例失败。

已用干净 worktree 二分定位：HEAD 干净树 134/134 通过（9.9s）；
同一棵树只额外执行一次引擎 `npm run build`，即复现 4 failed | 130 passed（23.9s）。
**与任何源码改动无关。** 这不是新引入的回归，而是一个一直存在、
因为引擎从没被编译过所以从没暴露的隐性环境依赖。修的方向是让这几个用例
显式控制引擎可用性（注入不可用的 engineCommand 或直接断言引擎侧状态），
而不是依赖「dist 恰好不存在」。

---

## 5. 分工对接（按会议名单）

### 陈万康 — 第 1、2 项：候选识别 + 候选确认

**这是当前唯一的硬阻塞（B1）。** 证据流里不存在「能力主张」这个语义，
没有识别器，整条链路只能读得出证据、聚得出 run，**不会自动产生任何候选**。

**你需要实现的接口（已定义，位于 `features/recall/kstar-evidence-adapter.ts`）：**

```ts
export type EvidenceRecognizer = (run: EvidenceRun) => Promise<RecognizerOutput | null>;

export interface RecognizerOutput {
  judgment: string;          // 必填：一句能力主张
  summary?: string;
  uncertainty?: string;
  suggestedType?: 'personal' | 'rule' | 'template' | 'skill_method';
  suggestedScope?: string;
  confidence?: number;       // 0..1；没把握就不要给，不要填 0
}
```

**你会拿到的输入：**

```ts
interface EvidenceRun {
  runKey: string;                  // conversation::agent::turn
  conversationId, agentId, turnId: string;
  toolCycles: EvidenceRecord[];    // 按时间升序，已去重
  contribution: EvidenceRecord | null;  // 该 run 的最终产出
  startedAt?: string;
  degraded: boolean;               // true 时不会调用你，直接跳过
}
```

**约定：**

- 判断不出来就返回 `null`，**不要编造 judgment**。返回 null 会记为
  `{ status: 'skipped', reason: 'no_judgment' }`，是正常结果不是错误。
- `confidence` 缺失即 absent。传 NaN / >1 / <0 / 字符串会**抛错**，不会被强转。
- 三种识别场景（实时 / 圈选 / 夜间）都可复用同一接口——它们的差别在**何时调用**，
  不在返回结构。夜间批量识别可以直接把 `groupEvidenceIntoRuns()` 的结果喂进来。

**第 2 项（候选确认）**：`recall.candidates.*` 的六个 IPC 已全部存在并可用
（save / update / promote / reject / defer / resume），
`src/renderer/modules/skills-bindings.js` 里已有 promote/reject/defer/resume 的绑定。
**开工前先看一眼现有实现，避免重复建设。**

候选状态机（现有，不要改）：
`pending → deferred → pending`、`pending → rejected`（终态）、`pending → promoted`（终态）。

### 张照航 — 第 4 项：基于 KSTAR 的认知资产复用

**你从能力册拿数据的方式（不需要我推送）：**

```
recall.projections.preview  { taskRunId, workspaceId?, purpose, authorization?, expiresAt? }
                            → { assetIds, sourceRefs, omittedRefs }
recall.projections.confirm  { projectionId }
```

能力册**不主动向 KSTAR 推送资产**，由你在派发前拉投影。这条边界保证能力册不介入派发路径。

**执行后请回写：**

```
recordRecallUsage({ assetId, assetVersion, taskRunId, projectionId?, boundary, outcome? })
```

`boundary` 如实填 `real` / `degraded` / `test-double`。
详情页会把非 `real` 的记录**显式标注**，避免 mock 被当成真实复用证据。

**另外归你的两项引擎侧问题：**

- **B4 死代码清理**：`packages/nseap-meta-skill-engine/src/persistence/tool-catalog.ts`
  声明了 13 个工具（含 `add_evidence`），但**从未挂到 MCP server 上**，
  `getToolCatalog()` 无任何运行时引用，只有一个测试断言它有 13 项。
  本轮按 PC 实际调用实现了 `record_evidence`（形状不同）。两套并存会让后来者困惑，
  请确认是删除还是另有计划。
- **B7 DeltaR 语义化**：当前只做字符串相等/不等，无语义预测比对。
  **它决定效果评估能否自动化，进而决定成熟度能否自动从 `transfer_validated`
  升到 `effectiveness_validated`** —— 也就是直接卡住你自己第 4 项的闭环。

**两个需要你确认的结构问题（B2、B3）：**

1. `collaboration_close` 的 id 内嵌 `Date.now()` → 引擎按 id 幂等去重对它失效，重放会堆积。
   建议改稳定 id。在此之前能力册把它排除在聚合键外，只当收口信号。
2. `agent_run_result` 只有 start 没有 end → 单个 run 是否完成只能从 conversation 级间接推断。
   建议补 run 级结束事件。

### 张浩 — 第 5 项：本体信息抽取（B6）

抽取结果若要进能力册，产出 `CognitionSourceRef`，`kind` 填 `'ontology'`：

```ts
{ kind: 'ontology', id: string, title?: string, excerpt?: string }
```

**`id` 必须匹配 `[A-Za-z0-9_-]+`**，否则整条 ref 会被 `normalizeCognitionSourceRefs`
**静默丢弃且不报错**（见 §3）。这是个真实陷阱，务必注意。

### 刘婷婷 — 第 6 项：60秒旅程

与能力册无直接接口依赖。若旅程中要展示"系统学到了什么"，
可读 `recall.assets.list`；未注册场景下资产列表为空是正常状态，
展示层已有空态文案 `cognition.no_ability_assets`。

### 史雨萱 — 第 3 项：本文档交付方

已完成：S1–S8（见 §1）、B5（serverInfo 版本统一）、B8 的启动+握手部分。
待办：B8 剩余的跨重启验证、N1 副作用入口（等 B8 通过后接）。
B9 已定位到根因但未修，需指派。

## 6. 本轮改动文件

**已提交** `0f2c7de`：

```
packages/nseap-meta-skill-engine/src/index.ts              引擎三工具
packages/nseap-meta-skill-engine/src/persistence/kstar-state.ts   新增
packages/nseap-meta-skill-engine/README.md                 工具数 23 → 29
packages/nseap-meta-skill-engine/test/kstar-state.test.ts  新增
packages/nseap-meta-skill-engine/test/mcp-process-kstar-snapshot.test.ts  新增
src/main/features/p3394/kstar-adapter.ts                   hydration + 落盘
test/main/features/p3394/kstar-adapter.test.ts             +4 用例
.npmrc                                                     依赖源镜像
```

**未提交**：

```
src/main/features/recall/candidate-service.ts       confidence / sourceSessionIds
src/main/features/recall/kstar-evidence-adapter.ts  新增，N1 纯函数层
src/main/ipc/index.ts                               confidence 参数校验
src/renderer/modules/ability-asset-status.js        新增，状态映射
src/renderer/modules/skills.js                      版本历史 + 使用记录
src/renderer/modules/lazy-features.js               模块加载顺序
src/renderer/locales/{zh,en,ja,pt}.json             +18 键/语言
src/renderer/style.css                              .asset-history-*
test/…（4 个测试文件，新增 81 用例）
docs/…（4 份文档）
```

**未改动**（重要边界）：KSTAR 状态机、candidate/asset 底层状态词表、
引擎除三工具外的任何逻辑、group_chat、任何派发路径。
