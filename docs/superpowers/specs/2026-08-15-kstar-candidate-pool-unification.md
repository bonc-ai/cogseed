# KStar 沉淀统一候选池 + 语义去重 + 自动闭环 设计（整合版 v4）

- 日期：2026-08-15（v4 整合 v1 管线统一 / v2 语义去重 / v3 自动闭环 / v3.1 质量融合）
- 分支：`codex/commander-centric-kstar`（已合并 develop 39 提交）
- 状态：Design Review（已确认方向：统一候选池、语义去重、自动闭环、晋升前资产查重、质量融合）
- 关联：P3394 认知资产全生命周期规范 doc-v0.1（§3.1 统一链路、§8 候选资格、§9 轻量确认、§10.4 版本冻结、§15 重复/补充/冲突）
- 目标读者：PO、Tech Lead、产品设计、QA
- 配套文档：`2026-08-15-capture-line-changes.md`（对 capture 线的改动说明）

---

## 1. 背景与问题

### 1.1 三层问题

**A. 管线重复（两条线各写各的资产）**

| | **KStar 线（我们）** | **认知候选线（develop capture）** |
|---|---|---|
| 入口 | `startGroupKstarClosure`（bus 终态订阅） | `startRecallCaptureOrchestrator`（`index.ts:1141` 启动即注册） |
| 提取源 | Commander in-context review 的 `lesson` | 消息流 LLM 提取（`parseRecallCaptureOutput`） |
| 写资产 | `createSystemAbilityAsset`（direct-experience） | `saveRecallCandidate` → `autoApplyRecallCandidate` → `promoteRecallCandidate(actor:'system')` |
| 资产 id | `aa-sha256(judgment+evidence)`（内容寻址） | `aa-sha256(candidateId+reviewDecisionId)`（候选寻址） |
| 跨线去重 | ❌ 无 | ❌ 无 |

**B. 内容重复（语义相近的 lesson 各存一份）**

live 证据（46 候选 + 9 资产）：
- "只要 3 条要点" / "用 N 条要点说明 X" / "反复要求只要 3 条要点"——**同一规则三条并存**
- 46 候选主题分布：输出格式/交付约束 14 条、审查方法 12 条、架构职责 8 条
- 资产 aa-ee1f9ca3（默认 Markdown）与候选"默认使用 Markdown 格式"——**同一规则双存**

**C. 闭环死区（沉淀依赖用户行为）**

闭环只有 3 个入口（B2 任务切换 / 显式 finish / abandon），全部依赖用户动作。任务完成但用户不说话 → 任务永远 open → lesson 永远不沉淀（live：孙悟空任务 review 带 lesson 但卡在 open）。

### 1.2 根因

1. 两套系统各自实现"任务终态 → 提取 → 沉淀"，无共享候选池与跨线去重
2. 去重是**精确匹配**（fingerprint 逐字归一化），措辞不同即视为不同
3. 闭环触发完全依赖用户下一步动作，无空闲自动收敛

---

## 2. 设计目标

1. **统一落点**：KStar 沉淀先进统一候选池（复用 `saveRecallCandidate`），不再直写资产
2. **三层去重**：精确指纹（逐字）→ 语义相似（embedding）→ 质量择优融合（重复总结成一条）
3. **自动闭环**：任务终态 + 静默窗口 → 自动 finish 沉淀，不依赖用户发新任务
4. **确认策略不变**：延续 self-evolution（质量合格自动确认）；高风险/内容变化留"待我处理"
5. **投影/复用不受影响**：资产晋升后才被投影；候选不注入
6. **来源可溯**：候选带 `learningProvenance`（projectionId/forecastId/episodeId/attribution）标记 KStar 来源

---

## 3. 统一管道设计（管线重复修复）

### 3.1 目标链路

```
任务终态（bus TaskTerminalEvent）
        │
        ├─── capture 线：静默 10min → LLM 提取 ──┐
        │                                        │
        └─── KStar 线：自动闭环（30min）或用户触发 ─┼───┐
                                             ▼    ▼
                                  统一候选池（saveRecallCandidate）
                                             │
                              ┌──────────────┴──────────────┐
                              ▼                             ▼
                   语义去重层（§4）                  精确指纹去重（现成）
                   候选池 + 资产库 + 质量融合
                              │
                              └──────────────┬──────────────┘
                                             ▼
                                  quality 评估（reviewable + risk + eligibility）
                                             ▼
              ┌──────────────────────────────────────────────────┐
              │ 合格 + 低风险      → promoteWithSemanticDedup（晋升前资产查重）│
              │ 合格 + 高风险      → review_ready → 用户"待我处理"           │
              │ 证据不足          → weak_observation（弱观察池）             │
              │ 内容变化（融合）   → update 候选 → 用户确认 → 新版本            │
              └──────────────────────────────────────────────────┘
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

#### 3.2.2 晋升：统一出口 `promoteWithSemanticDedup`（§4.7）

#### 3.2.3 `task-level-precipitation.ts`：调用点替换

`precipitateRequirementLevel` 中的 `precipitateDirectExperienceFromSource` → `precipitateKstarCandidatesAsAssets`（新封装）。`createdAssetIds` 语义保留，新增 `candidateIds` / `mergedIntoIds` / `updateCandidates`。

#### 3.2.4 capture 线：接入统一出口（详见配套改动说明）

#### 3.2.5 投影/检索：不动

资产晋升后照常进投影；候选不注入（符合规范"候选不默认使用"）。

---

## 4. 语义去重层设计（内容重复修复）

### 4.1 定位

三层递进去重：

```
第 1 层 精确指纹（现成）：fingerprint 相等 → 直接合并（已有逻辑）
第 2 层 语义相似（新增）：embedding 余弦 ≥0.85 → 质量择优融合（§4.9）
第 3 层 主题聚合（可选）：低相似但同主题高频 → 聚合提示
```

### 4.2 复用基础设施（已确认可用）

| 组件 | 位置 | 用途 |
|---|---|---|
| `embedTexts` / `embedQuery` | `src/main/features/kb_embed.ts` | bge-small-zh-v1.5 中文 embedding（已初始化） |
| `cosineScore` | `src/main/features/recall/context-projection.ts:232` | 余弦相似度（提取为共享工具） |
| 候选池遍历 | `listRecallCandidates` / `listAbilityAssets` | 比对对象 |

### 4.3 相似度阈值

| 区间 | 判定 | 动作 |
|---|---|---|
| ≥ 0.85 | 语义重复 | 质量择优融合（§4.9） |
| 0.70 – 0.85 | 高度相关 | 标记 `relatedTo`，或按冲突/补充进"待我处理" |
| < 0.70 | 独立 | 正常入库 |

阈值待校准（命名常量集中定义）。

### 4.4 弱观察升级联动

语义命中 ≥0.85 计入该经验"出现次数"：≥2 次 → weak_observation → pending_review（重复即证据）。

### 4.5 性能与缓存

- 候选池规模小（当前 46 条），入池/晋升时全量比对可接受
- embedding 结果 LRU 缓存（judgment → vector，按 userId）
- 池 >500 条时降级抽样比对 + 精确指纹兜底

### 4.6 入池时查重（对候选池 + 资产库）

- 命中候选 ≥0.85 → 合并证据，返回已有（可能 weak→pending 升级）
- 命中资产 ≥0.85 → 证据并入资产（version 不变）；0.7-0.85 → 标记 `targetAssetId`（update 候选）
- 未命中 → 正常入库

### 4.7 晋升前资产语义查重（统一出口，防时序竞争）

**时序竞争**：capture 每 run ~10min 实时晋升 vs KStar 闭环 30min+ 聚合。入池查重挡不住"capture 已把同内容写成资产、KStar 闭环后才发现"或"两候选措辞不同同语义各自晋升"。

**方案**：共享函数 `promoteWithSemanticDedup(userId, candidateId, opts)`：
1. 晋升前对**资产库**语义查重（≥0.85）
2. 命中 → 按 §4.9 质量融合；候选标记 `mergedIntoAssetId`
3. 未命中 → 走原 `promoteRecallCandidate`

**两条线都走该出口**（KStar 封装内 + capture `automaticallyApplyReviewableCandidates` 注入替换）。

### 4.8 时序一致性矩阵

| 场景 | 入池查重 | 晋升查重 | 结果 |
|---|---|---|---|
| capture 先晋升，KStar 后入池 | 命中资产 → 并入 | — | 一份 ✅ |
| KStar 先晋升，capture 后晋升 | 命中资产 → 并入 | — | 一份 ✅ |
| 两候选措辞不同同语义，先后晋升 | 各不命中 | **晋升时命中 → 融合** | 一份 ✅ |
| 同 run 内多条相似候选 | 指纹/语义合并 | — | 一份 ✅ |

### 4.9 基于质量的融合策略（重复总结成一条）

**质量评分 `assetQualityScore(record)`**（五维，权重待校准）：

| 维度 | 权重 | 打分 |
|---|---|---|
| 成熟度 maturity | 0.30 | seed=1 → stable=5 |
| 内容完整度 | 0.25 | statement 长度 + 结构（何时适用/例外/步骤） |
| 证据强度 | 0.25 | evidenceRefs 数量 + 五类来源覆盖 |
| 时效性 | 0.10 | 更新时间线性衰减 |
| 风险 | 0.10 | low=1.0, medium=0.6, high=0（不参与自动合并） |

**融合规则（语义命中 ≥0.85）**：

```
A. 新候选质量更高（分差 ≥0.10）
   → 以新内容为主体 + 旧证据合并
   → 命中资产：生成 update 候选（targetAssetId）走 §15.2 补充流程（不静默覆盖）
   → 命中候选：更新内容，weak → pending_review 升级

B. 已有资产/候选质量更高或相当
   → 保留主体，新证据并入；候选标记 mergedInto / mergedIntoAssetId

C. 内容互补（A 有触发条件、B 有例外）
   → judgment 融合（主体 + 对方独有细节），证据全并
   → 标记 mergedFrom: [A, B]，可审计回滚
```

**版本冻结**：融合产生新版本不覆盖旧版，旧 TaskRun 继续引用旧版（规范 §10.4）。

---

## 5. 静默窗口自动闭环（KStar 线不再依赖用户触发）

### 5.1 问题

闭环 3 入口全部依赖用户行为。任务完成用户不说话 → 永不沉淀。

### 5.2 方案

```
任务终态（turn_end）
  → 启动静默窗口（默认 30min，常量 AUTO_CLOSE_QUIET_MS）
  → 窗口内无新用户消息 → 自动 finish → 沉淀（precipitateRequirementLevel）
  → 窗口内有用户消息 → 取消；judge 判 continuation 决定去留
```

### 5.3 关键设计点

| 问题 | 方案 |
|---|---|
| 误关风险 | 窗口 30min；用户发消息即取消；judge 判 continuation |
| 重启丢失定时器 | task-state 写 `pendingAutoCloseAt`；启动 `recoverPendingAutoClosures` 扫描恢复（对齐 capture `recoverRecallCaptures`） |
| 闭环后回来继续 | 新消息 judge 判 continuation → 开新任务（投影接续），原任务保持已沉淀 |
| 与 capture 协调 | capture quietMinutes=10min 实时提取；KStar 窗口 ≥30min（任务级闭环比提取重） |
| 触发点 | `startGroupKstarClosure` terminal 订阅内启动窗口 |
| 沉淀内容 | 走现有 finish → `precipitateRequirementLevel`（闭环聚合） |
| 确认策略 | 自动闭环不改变确认策略：产物进候选池，高风险/内容变化留"待我处理" |
| 幂等 | 走同一 finish 控制路径，idempotencyKey 区分来源；已闭环不重复沉淀 |

### 5.4 状态机

```
open（活动）
  ├─ run 终态 → 启动窗口（pendingAutoCloseAt = now + 30min）
  │     ├─ 窗口内用户消息 → 取消 → open（continuation 判定）
  │     └─ 窗口到期 → finish（沉淀）→ waiting_review
  └─ 用户显式 finish / B2 切换 / abandon → 取消窗口 → 正常闭环
重启恢复：扫描 task-state 未过期且 open → 重建定时器（剩余时间）
```

---

## 6. 状态流转（候选生命周期，含语义合并）

```
KStar lesson / capture 提取
  → 语义查重（§4）
      ├─ 命中候选（≥0.85）→ 质量融合 → 返回已有（weak→pending 升级）
      ├─ 命中资产（≥0.85）→ 质量融合（§4.9 A/B/C）
      └─ 未命中 → saveRecallCandidate（精确指纹兜底）
          ├─ pending_review（reviewable）── 高风险 → review_ready（用户"待我处理"）
          │                                 └ promoteWithSemanticDedup → confirmed → 资产
          └─ weak_observation（证据不足）── 出现≥2次 → 重评 → pending_review
  → 用户动作（"待我处理"页）：
      promote / 修改后保存 / 保持当前版本 / 拒绝 / 忽略 / 稍后
```

---

## 7. 测试计划

| 用例 | 断言 |
|---|---|
| KStar lesson → 候选入库 | candidates/ 新增记录，captureKey `kstar-...`，fingerprint 正确 |
| 质量合格自动晋升 | 候选 confirmed → 资产存在，lifecycle `automatically_extracted_unverified` |
| 语义去重：措辞不同同规则 | "只要 3 条要点" vs "用 N 条要点说明 X" → 同候选，证据合并，仅一条 |
| 语义去重：候选 vs 资产（入池时） | 新 lesson 与既有资产相似 ≥0.85 → 不新建候选，证据并入资产 |
| 晋升前语义查重（时序竞争） | 候选 A 已晋升资产 X；候选 B（同语义）晋升 → 命中 X → 不新建，仅一份 |
| 质量融合：新候选质量更高 | 生成 update 候选（targetAssetId），不静默覆盖；合并为新版本 |
| 质量融合：已有资产质量更高 | 证据并入，候选标记 mergedIntoAssetId，资产不新增 |
| 质量融合：互补内容 | judgment 融合 + 证据全并 + mergedFrom 标记 |
| 版本冻结 | 融合新版本不覆盖旧版，旧 TaskRun 仍引用旧版 |
| 弱观察升级 | 同规则 ≥2 次语义命中 → weak_observation → pending_review |
| 高风险留待确认 | risk=high → review_ready，资产不写，UI 可见 |
| 证据不足弱观察 | forceWeakObservation → weak_observation，不打扰 |
| 投影不受影响 | 资产晋升后才进投影；候选不进 |
| 静默窗口自动闭环 | run 终态 → 窗口到期无消息 → 任务 finish + 沉淀 |
| 窗口取消 | 窗口内用户消息 → 不闭环；continuation=true → 保持 open |
| 重启恢复 | task-state pendingAutoCloseAt 未过期 → 启动重建 → 到期闭环 |
| 回归 | 现有 1169 项全过 |

---

## 8. 分步实施

1. **共享工具**：`cosineScore` 提取为 `recall/similarity.ts`；embedding LRU 缓存
2. **语义查重**：`findSemanticDuplicate(userId, { judgment, sourceRefs })` → `{ match: candidate|asset, score }`
3. **质量评分**：`assetQualityScore(record)`（§4.9 五维）
4. **统一晋升出口**：`promoteWithSemanticDedup(userId, candidateId)`（§4.7 + §4.9 融合）——capture 与 KStar 共用
5. **封装层**：`precipitateKstarCandidatesAsAssets`（语义查重 → saveRecallCandidate → promoteWithSemanticDedup → 汇总）
6. **替换**：`direct-experience-assets.ts` / `task-level-precipitation.ts` 落点切换
7. **capture 接入**：`automaticallyApplyReviewableCandidates` 的 `autoApplyRecallCandidate` → `promoteWithSemanticDedup`（详见配套改动说明）
8. **自动闭环**：`task-closure.ts` 静默窗口 + task-state `pendingAutoCloseAt` + bus 启动 `recoverPendingAutoClosures`
9. **合并逻辑**：主候选保留 + mergeSourceRefs + mergedInto/mergedFrom 标记 + 弱观察升级
10. **测试**：§7 用例 + 回归
11. **联调**：真实任务 → 自动闭环 → 候选入库 → 晋升（语义去重+质量融合）→ 资产投影；"待我处理"UI 确认高风险/0.7-0.85/update 候选

---

## 9. 开放问题

| ID | 问题 | 默认处理 |
|---|---|---|
| OQ-1 | KStar lesson 的 risk 如何定 | 复用 capture screening，最小改动 |
| OQ-2 | 语义阈值 0.85/0.70 未校准 | 命名常量，历史数据校准 |
| OQ-3 | 语义合并后资产 version 是否 bump | 证据并入不 bump；内容变化走 update 候选 |
| OQ-4 | 旧 9 资产 + 46 候选初始语义清理 | 实施后跑一次性清理，报告合并建议 |
| OQ-5 | 弱观察升级阈值（2 次） | 可校准 |
| OQ-6 | 语义比对性能上限（>500 条） | 抽样比对 + 指纹兜底 |
| OQ-7 | 静默窗口时长（30min） | 常量 AUTO_CLOSE_QUIET_MS，可校准 |
| OQ-8 | 自动闭环与显式 finish 幂等 | 同一 finish 控制路径，idempotencyKey 区分 |
| OQ-9 | 闭环后回来继续的接续体验 | 开新任务 + 投影接续（规范 §12.1 快照语义） |
| OQ-10 | 质量评分权重未校准 | 命名常量，与语义阈值同批校准 |
| OQ-11 | 融合 update 候选是否需用户确认 | 内容变化 → 用户确认（默认）；纯证据合并 → 自动 |
| OQ-12 | 融合 judgment 追加规则噪音控制 | 长度上限 + 结构提示；mergedFrom 可回滚 |
