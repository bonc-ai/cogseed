# capture 线（develop 认知候选线）改动说明（实现版）

- 日期：2026-08-15（实现合入 develop：MR `0dd668db`）；本文档为 08-16 补齐的实现记录
- 分支：`codex/commander-centric-kstar`
- 计划版：`2026-08-15-capture-line-changes.md`（设计/计划）
- 配套：`2026-08-15-kstar-candidate-pool-unification.md`（主设计文档 v4）
- 范围：capture 线（LLM 从消息流提取的认知沉淀）为接入统一候选池所做的**实际代码改动**，含与计划版的差异说明

---

## 1. 实现概况

08-15 目标：capture 线与 KStar 线**共用一套沉淀管道**——两条线各自提取 → 统一候选池（`saveRecallCandidate`）→ 同一晋升出口（`autoApplyRecallCandidate`）→ 晋升前对资产库做**语义查重 + 质量融合**，重复总结成一条。

### 1.1 与计划版的关键差异

| 计划版（`capture-line-changes.md` §2.1） | 实际实现 |
|---|---|
| capture-service 两处晋升调用替换为 `promoteWithSemanticDedup` | **未执行，capture-service.ts 零改动** |
| 新增共享函数 `promoteWithSemanticDedup` 作为统一出口 | 语义查重**内聚进 `autoApplyRecallCandidate` 内部**（`semanticDedupBeforePromote`），不新增导出 |

**为什么这样改**：capture 的自动晋升（`automaticallyApplyReviewableCandidates`）本来就调用 `autoApplyRecallCandidate`，测试也以它做 mock 面。把语义查重放进该函数内部（默认开启，`opts.semanticDedup !== false` 控制），两条线自动获得同一行为，**capture 调用点与测试 mock 面完全不变**（capture 既有 68 项测试全过）。

### 1.2 统一出口后的数据流

```
capture 线（消息流提取）──┐
                          ├─→ saveRecallCandidate（统一候选池，指纹去重）
KStar 线（任务闭环沉淀）──┘
                          │
                          ▼
              autoApplyRecallCandidate（共享晋升出口）
                          │
              ┌───────────┴───────────┐
              │ semanticDedupBeforePromote（晋升前查重）
              │  未命中 → 原 promote 路径（行为不变）
              │  命中资产 → 质量融合（§3）
              │  命中候选 → 证据合并
              └───────────┬───────────┘
                          ▼
                  认知资产（ability-assets）
```

---

## 2. 实际改动清单

| 文件 | 改动 | 量 |
|---|---|---|
| `src/main/features/recall/similarity.ts` | **新增**：语义查重 + 质量评分共享模块 | +184 |
| `src/main/features/recall/candidate-service.ts` | `autoApplyRecallCandidate` 内嵌查重；生命周期 3 自动值；`mergedIntoAssetId` 回报 | +157/-2 |
| `src/main/features/recall/asset-service.ts` | `migrateLegacyUserFacingTitles`（存量英文标题→中文） | +53 |
| `src/main/features/recall/capture-service.ts` | **零改动**（语义查重内聚后不需要） | 0 |
| `src/main/index.ts` | boot 延迟注册标题迁移 | +3 |
| `src/renderer/modules/skills.js` | 候选/资产展示中文化 + 可折叠卡片 | 多处 |
| `src/renderer/recall-local.css` | 可折叠样式 | 少量 |
| `src/renderer/locales/{zh,en}.json` | `cognition.asset_view_content` 等键 | 少量 |

### 2.1 `similarity.ts`（新增）

| 导出 | 职责 |
|---|---|
| `SEMANTIC_DUP_THRESHOLD = 0.85` | 语义重复判定阈值（cosine ≥0.85） |
| `SEMANTIC_RELATED_THRESHOLD = 0.70` | 弱观察升级联动阈值（保留给后续校准） |
| `QUALITY_GAP = 0.10` | 质量融合中"新候选显著更优"的差值门槛 |
| `QUALITY_WEIGHTS` | 五维权重：成熟度 0.30 / 内容完整度 0.25 / 证据 0.25 / 时效 0.10 / 风险 0.10 |
| `cosineScore(left, right)` | 向量余弦（自 context-projection 提取，原处 re-export） |
| `embedForDedup(userId, text)` | kb_embed.embedQuery + 按 userId 的 LRU 缓存 |
| `findSemanticDuplicate(userId, input)` | 遍历候选池 + 资产库，返回最高分命中（≥0.85） |
| `assetQualityScore(record)` | 五维质量评分（0~1） |
| `_injectEmbeddingForTest` / `clearEmbedCacheForTest` | 测试注入（无 ONNX 环境） |

### 2.2 `candidate-service.ts`

- `autoApplyRecallCandidate(userId, id, { semanticDedup? })`：晋升前调用 `semanticDedupBeforePromote`；**embed 退化时 `findSemanticDuplicate` 返回 null → 走原 promote 路径（行为与现状一致）**
- `semanticDedupBeforePromote`：装配候选池+资产库可比文本 → 查重 → 融合（§3）
- `RecallAbilityAssetLifecycleStatus`：`user_confirmed_unverified | automatically_extracted_unverified | system_precipitated_unverified`（两个自动值读回不丢）
- 候选命中时同样回报 `mergedIntoAssetId`（KStar 线 v4 测试 2 覆盖）

### 2.3 `asset-service.ts` + `index.ts`

- `migrateLegacyUserFacingTitles`：幂等迁移存量资产标题（`Reusable experience lesson (requirement-level)` → `可复用经验（scope）` 等 4 条规则 + statement 修正），跳过 revoked/purged，逐条 audit
- boot 延迟任务注册（`index.ts`），不阻塞启动；无存量则零开销

### 2.4 共享渲染层（两条线共用 UI）

- `_abilityAssetScopeLabel`：scope → 中文（report/code/review/product/general）
- `_abilityCandidateDisplayTitle` / `_abilityTitleFromContent`：存量英文候选标题 → 内容派生的中文
- 候选与资产卡片改为 `<details>` 可折叠（`.recall-collapsible-*` 样式，chevron 旋转）
- locales：`cognition.asset_view_content`（查看内容）等

---

## 3. 行为变化对照（改动前后）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| capture 候选晋升，资产库无重复 | 直接写资产 | 相同（查重未命中走原路径） |
| capture 候选晋升，资产库已有同语义资产（KStar 先沉淀） | **双写**（两资产并存） | 融合为一份 |
| 两个 capture run 同语义、措辞不同 | 各晋升 → 双资产 | 后者融合前者（或生成 update 候选） |
| 用户手动 promote（"待我处理"页） | 精确查重 | **不变**（显式决定不接语义查重，同计划 C-OQ-1 默认） |
| embed 服务退化 | — | 查重返回 null → 原 promote，行为不变 |
| 生命周期读回 | 自动值可能被规范化掉 | 两个自动值原样保留 |

### 3.1 质量融合规则（命中资产时）

```
scoreIn = assetQualityScore(新候选)；scoreEx = assetQualityScore(已有资产)
- scoreIn - scoreEx ≥ 0.10  → 生成 update 候选（targetAssetId=已有资产，内容=新+旧证据），不自动写资产
- 互补（各含对方独有结构） → 生成 update 候选（judgment=主体+对方独有细节，mergedFrom=[both]）
- 其余（已有更高/相当）     → 证据并入已有资产，新候选标记 mergedIntoAssetId（mergedIntoAssetId 回报调用方）
```

---

## 4. 兼容性与回归

- **数据兼容**：不迁移存量候选/资产（除标题迁移，幂等、可重入）
- **接口兼容**：`autoApplyRecallCandidate` 签名不变（新增可选 `opts.semanticDedup`）；`promoteRecallCandidate` / `saveRecallCandidate` 原样保留
- **行为兼容**：capture 自动晋升触发条件、状态机、失败处理（failedCandidateIds）不变
- **性能**：晋升前一次 embedQuery + 池/资产遍历（当前量级可忽略）+ LRU 缓存
- **回归**：capture 68 + recall 440 + kstar 151 + bus-integration 146 全绿

---

## 5. 与 KStar 线的边界

| 内容 | 归属 |
|---|---|
| `task-closure.ts` / `bus.ts`（auto-close 窗口） | KStar 线（08-16 P0 修复：internal-control 回合不再取消窗口，`569c0774`） |
| `direct-experience-assets.ts` / `task-level-precipitation.ts` | KStar 线（落候选池 + 沉淀） |
| `similarity.ts` / `candidate-service.ts` | **共享**（两条线同一晋升出口） |
| `capture-service.ts` | capture 线（本轮零改动） |
| `skills.js` / `recall-local.css` / locales | 共享 UI（两条线资产展示） |

---

## 6. 已知事项 / 校准点

| ID | 事项 | 状态 |
|---|---|---|
| C-1 | 阈值 0.85/0.70 与质量权重（0.30/0.25/0.25/0.10/0.10）为**常数**，未经真实语料校准 | 待校准（主文档 OQ-7） |
| C-2 | 4 个存量资产标题仍为"可复用经验（通用）"（迁移规则未覆盖） | 可选用 `lessonTitleCore` 迁移为内容化标题，未执行 |
| C-3 | `cognition.asset_view_content` 缺 ja/pt locale | 待补（en/zh 已加） |
| C-4 | capture 线 `risk` 维与质量评分风险维不重复（同计划 C-OQ-2） | 保持现状 |
