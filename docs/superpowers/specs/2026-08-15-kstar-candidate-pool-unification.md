# KStar 沉淀统一候选池 + 语义去重设计（v2 整合版）

- 日期：2026-08-15（v1 管线统一；v2 整合语义去重）
- 分支：`codex/commander-centric-kstar`（已合并 develop 39 提交）
- 状态：Design Review
- 关联：P3394 认知资产全生命周期规范 doc-v0.1（§3.1 统一链路、§8 候选资格、§9 轻量确认、§15 重复/补充/冲突）
- 目标读者：PO、Tech Lead、产品设计、QA

---

## 1. 背景与问题

### 1.1 两个层面的重复问题

合并 develop 后暴露**两层重复**，均需解决：

**A. 管线重复（两条线各写各的资产）**

| | **KStar 线（我们）** | **认知候选线（develop）** |
|---|---|---|
| 入口 | `startGroupKstarClosure`（bus 终态订阅） | `startRecallCaptureOrchestrator`（`index.ts:1141` 启动即注册） |
| 提取源 | Commander in-context review 的 `lesson` | 消息流 LLM 提取（`parseRecallCaptureOutput`） |
| 写资产 | `createSystemAbilityAsset`（direct-experience） | `saveRecallCandidate` → `autoApplyRecallCandidate` → `promoteRecallCandidate(actor:'system')` |
| 资产 id | `aa-sha256(judgment+evidence)`（内容寻址） | `aa-sha256(candidateId+reviewDecisionId)`（候选寻址） |
| 跨线去重 | ❌ 无 | ❌ 无 |

**B. 内容重复（语义相近的 lesson 各存一份）**

live 证据（2026-08-15，46 候选 + 9 资产）：
- "用户要求**只要 3 条要点**" / "当用户要求**用 N 条要点说明 X** 时按 N 条输出" / "两轮请求中反复要求**只要 3 条要点**" —— **同一规则，三条并存**
- 46 条候选按主题粗分：**输出格式/交付约束 14 条**、审查方法 12 条、架构职责 8 条——大量同主题、措辞各异
- 资产 `aa-ee1f9ca3`（"默认 Markdown 不生成 Word"）与候选"用户以后生成作文默认使用 Markdown 格式"——**同一规则，一边已是资产、一边还在候选池**

### 1.2 根因

1. 管线重复：两套系统各自实现"任务终态 → 提取 → 沉淀"，无共享候选池与跨线去重。
2. 内容重复：去重是**精确匹配**（`fingerprint` = judgment 逐字归一化比较；`comparableCandidateText` = 空白归一化小写）。措辞不同即视为不同 → "只要 3 条要点"与"用 N 条要点说明"并存。弱观察池（weak_observation）只累积不合并。

规范 §8.3 的"**语义分流 → 与现有资产和候选去重 → 判断补充、冲突、过期**"环节，当前只有精确层，缺语义层。

---

## 2. 设计目标

1. **统一落点**：KStar 沉淀先进统一候选池（复用 `saveRecallCandidate`），不再直写资产
2. **三层去重**：精确指纹（逐字）→ 语义相似（embedding）→ 主题聚合（合并同类）
3. **确认策略不变**：延续 self-evolution（质量合格自动确认）；高风险/证据不足停"待我处理"
4. **投影/复用不受影响**：资产晋升后才被投影；候选不注入
5. **来源可溯**：候选带 `learningProvenance`（projectionId/forecastId/episodeId/attribution）标记 KStar 来源

---

## 3. 统一管道设计（管线重复修复）

### 3.1 目标链路

```
任务终态（bus TaskTerminalEvent）
        │
        ├─── capture 线：selectCaptureMessages → LLM 提取 ──┐
        │                                                   │
        └─── KStar 线：Commander review → lesson 提取 ────────┤
                                                             ▼
                                    统一候选池（saveRecallCandidate）
                                    │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
              语义去重层（§4）                  精确指纹去重（现成）
                     │                               │
                     └───────────────┬───────────────┘
                                     ▼
                            quality 评估（reviewable + risk + eligibility）
                                     ▼
              ┌────────────────────────────────────────────┐
              │ 合格 + 低风险 → autoApplyRecallCandidate（系统自动）│
              │ 合格 + 高风险 → review_ready → 用户"待我处理"      │
              │ 证据不足      → weak_observation（弱观察池）        │
              └────────────────────────────────────────────┘
                                     ▼
                             能力资产（ability-assets）
                                     ▼
                         投影检索 → 复用 → 使用与证明
```

### 3.2 改动点

#### 3.2.1 `direct-experience-assets.ts`：落点从资产改为候选

**现在**：`precipitateDirectExperienceFromSource` → `createSystemAbilityAsset`（直写资产）

**改为**：→ `saveRecallCandidate(userId, {
  judgment, value, summary, uncertainty,
  suggestedType, suggestedScope,
  sourceRefs, evidenceRefs,
  learningSignal, learningProvenance,
  captureKey: `kstar-${requirementId}-${index}`,
  taskRunId,
  forceWeakObservation: 质量不足时
})`

映射关系（proposal → SaveRecallCandidateInput）：

| KstarCandidateProposal | SaveRecallCandidateInput | 说明 |
|---|---|---|
| judgment | judgment | lesson 内容即候选判断（不变） |
| summary | summary | 资产标题（不变） |
| uncertainty | uncertainty | 不变 |
| suggestedType | suggestedType | 不变 |
| suggestedScope | suggestedScope | 不变 |
| sourceRefs | sourceRefs + evidenceRefs | 直接映射 |
| learningSignal | learningSignal | 不变 |
| learningProvenance | learningProvenance | **来源标记**（projectionId/forecastId/episodeId/attribution） |
| — | captureKey | `kstar-<requirementId>-<n>`，KStar 线内部幂等 |
| — | taskRunId | 当前 run |
| — | forceWeakObservation | 质量不足 → 弱观察 |

#### 3.2.2 晋升：复用 `autoApplyRecallCandidate`

候选入库后调用 `autoApplyRecallCandidate`：
- 已确认（confirmed）→ 幂等返回
- reviewable + 非高风险 → 系统自动 promote（actor:'system'）
- 高风险 → 抛错，候选停在 review_ready → 用户"待我处理"
- reject/keep_current 动作 → 走 decideWithoutAsset

封装 `precipitateKstarCandidatesAsAssets(userId, requirementId, proposals)`（新函数，取代原直写），内部：
1. 语义查重（§4）→ 命中则合并，未命中继续
2. `saveRecallCandidate` 入库（精确指纹去重兜底）
3. 对每个候选 `autoApplyRecallCandidate`
4. 汇总 `{ candidateIds, assetIds, skippedRiskIds, mergedIntoIds }`

#### 3.2.3 `task-level-precipitation.ts`：调用点替换

`precipitateRequirementLevel` 中的 `precipitateDirectExperienceFromSource` → 新封装。`createdAssetIds` 语义保留（晋升成功的资产 id），新增 `candidateIds` / `mergedIntoIds`（供 UI/待我处理/审计）。

#### 3.2.4 capture 线：不动

capture 已走 `saveRecallCandidate`，指纹去重自动与我们的候选合并。**不关闭 capture**——目标是共享去重池，不是消灭一条线。

#### 3.2.5 投影/检索：不动

资产晋升后照常进投影；候选不注入（符合规范"候选不默认使用"）。

---

## 4. 语义去重层设计（内容重复修复）

### 4.1 定位

在 `saveRecallCandidate` 的精确指纹之上加**语义层**：入池前判断"这条与池内已有候选/资产是否说同一件事"。三层递进：

```
第 1 层 精确指纹（现成）：fingerprint 相等 → 直接合并（已有逻辑）
第 2 层 语义相似（新增）：embedding 余弦相似度 ≥ 阈值 → 合并/提示
第 3 层 主题聚合（新增，可选）：低相似但同主题高频 → 聚合为一条
```

### 4.2 复用基础设施（已确认可用）

| 组件 | 位置 | 用途 |
|---|---|---|
| `embedTexts` / `embedQuery` | `src/main/features/kb_embed.ts` | bge-small-zh-v1.5 中文 embedding（已初始化，日志可见） |
| `cosineScore` | `src/main/features/recall/context-projection.ts:232` | 余弦相似度（提取为共享工具） |
| 候选池遍历 | `listRecallCandidates` / `listAbilityAssets` | 比对对象 |

### 4.3 相似度判定与阈值

| 相似度区间 | 判定 | 动作 |
|---|---|---|
| ≥ 0.85 | 语义重复 | **合并**：不新建；sourceRefs/evidenceRefs 合并到已有候选；weak_observation → 提升证据强度（如出现次数+1，达到阈值转 pending_review） |
| 0.70 – 0.85 | 高度相关 | 新建候选但标记 `relatedTo: <id>`；或按 §15 冲突/补充规则进入"待我处理"由用户判断 |
| < 0.70 | 独立 | 正常入库 |

阈值待校准（与投影选择 0.25/0.5 同属未校准参数，集中定义便于调参）。

### 4.4 合并策略

合并时保留**措辞最完整、证据最强**的一条：

1. 比较 judgment 长度（归一化后）与 evidenceRefs 数量
2. 保留更长/证据更多者为主候选
3. 被合并候选的 sourceRefs/evidenceRefs `mergeSourceRefs` 进主候选
4. 被合并候选状态 → `superseded`（或合并进 `learningProvenance` 的多个 episodeId）
5. 记录合并关系（`mergedInto`），可审计回滚

### 4.5 性能与缓存

- 候选池规模小（当前 46 条），入池时全量比对可接受（每候选一次 embedTexts + N 次余弦）
- embedding 结果缓存（`judgment → vector` 的 LRU，按 userId），避免重复计算
- 超过池上限（如 500 条）时降级为"仅精确指纹 + 抽样语义比对"

### 4.6 与既有资产的去重

语义比对对象**同时包含候选池与已沉淀资产**：
- 与资产相似 ≥0.85 → 不新建候选，证据并入资产（`sourceRefs` 追加，资产 version 不变——补充证据不进版本）
- 与资产相似 0.7-0.85 → 候选标记 `targetAssetId`（潜在 update 候选，走规范 §15.2 补充流程）
- 与资产 <0.7 → 正常新建候选

---

## 5. 状态流转（候选生命周期，含语义合并）

```
KStar lesson / capture 提取
  → 语义查重（§4）
      ├─ 命中候选（≥0.85）→ 合并证据 → 返回已有（可能 weak→pending 升级）
      ├─ 命中资产（≥0.85）→ 证据并入资产 → 不新建
      └─ 未命中 → saveRecallCandidate（精确指纹兜底）
          ├─ pending_review（reviewable）── 高风险 → review_ready（用户"待我处理"）
          │                                 └ autoApply → confirmed → 资产
          └─ weak_observation（证据不足）── 多次出现/证据累积 → 重评 → pending_review
  → 用户动作（"待我处理"页）：
      promote / 修改后保存 / 保持当前版本 / 拒绝 / 忽略 / 稍后
```

---

## 6. 测试计划

| 用例 | 断言 |
|---|---|
| KStar lesson → 候选入库 | candidates/ 新增记录，captureKey `kstar-...`，fingerprint 正确 |
| 质量合格自动晋升 | 候选 confirmed → 资产存在，lifecycle `automatically_extracted_unverified` |
| **语义去重：措辞不同同规则** | "只要 3 条要点" vs "用 N 条要点说明 X" → 同候选，证据合并，仅一条 |
| **语义去重：候选 vs 资产** | 新 lesson 与既有资产相似 ≥0.85 → 不新建候选，证据并入资产 |
| **弱观察升级** | 同规则多次出现（≥2 次语义命中）→ weak_observation → pending_review |
| 高风险留待确认 | risk=high → 候选 review_ready，资产不写，UI 可见 |
| 证据不足弱观察 | forceWeakObservation → weak_observation，不打扰 |
| 投影不受影响 | 资产晋升后才进投影；候选不进 |
| 回归 | 现有 1169 项全过（沉淀断言改为候选+晋升+合并断言） |

---

## 7. 分步实施

1. **共享工具**：`cosineScore` 从 context-projection 提取为 `recall/similarity.ts`（或 util）；embedding 缓存 LRU
2. **语义查重函数**：`findSemanticDuplicate(userId, { judgment, sourceRefs })` → 返回 `{ match: candidate|asset, score }`
3. **封装层**：`precipitateKstarCandidatesAsAssets`（语义查重 → saveRecallCandidate → autoApply → 汇总）
4. **替换**：`direct-experience-assets.ts` / `task-level-precipitation.ts` 落点切换
5. **合并逻辑**：主候选保留 + mergeSourceRefs + mergedInto 标记 + 弱观察升级
6. **测试**：§6 用例 + 回归
7. **联调**：真实任务 → 候选入库 → 自动晋升 → 资产投影；"待我处理"UI 确认高风险/0.7-0.85 候选

---

## 8. 开放问题

| ID | 问题 | 默认处理 |
|---|---|---|
| OQ-1 | KStar lesson 的 risk 如何定（复用 capture screening 还是 lesson 启发） | 复用 capture screening，最小改动 |
| OQ-2 | 语义阈值 0.85/0.70 未校准 | 命名常量集中定义，后续用历史数据校准（同投影阈值） |
| OQ-3 | 语义合并后资产 version 是否 bump（证据并入） | 证据并入不 bump 版本；内容变化才走 update 候选 |
| OQ-4 | 旧 9 个资产 + 46 个候选是否做一次初始语义去重清理 | 实施后跑一次性清理任务，报告合并建议 |
| OQ-5 | 弱观察升级阈值（几次语义命中转 pending_review） | 暂定 2 次，可校准 |
| OQ-6 | 语义比对的性能上限（池 >500 条） | 降级抽样比对，保持精确指纹兜底 |
