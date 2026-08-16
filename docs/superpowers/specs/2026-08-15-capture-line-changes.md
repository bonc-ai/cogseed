# 对 capture 线（develop 认知候选线）的改动说明

- 日期：2026-08-15
- 分支：`codex/commander-centric-kstar`
- 配套：`2026-08-15-kstar-candidate-pool-unification.md`（主设计文档 v4）
- 范围：本说明只描述**对 develop 既有代码（capture 线）的改动**；KStar 线自身改动见主文档 §3.2/§8

---

## 1. 改动原则

1. **最小侵入**：capture 线的提取、质量评估、状态机、UI 全部不动——它已经走 `saveRecallCandidate`（指纹去重），是统一候选池的正确入口
2. **只改一个出口**：capture 的**自动晋升**（`automaticallyApplyReviewableCandidates` → `autoApplyRecallCandidate`）替换为共享的 `promoteWithSemanticDedup`，让"晋升前资产语义查重 + 质量融合"对两条线统一生效
3. **不改变 capture 语义**：自动晋升的触发条件（reviewable + 非高风险 + automaticEligible）、状态流转、失败处理完全不变，只是在晋升前多一道"对资产库的语义查重"
4. **可回滚**：改动集中、带开关（`promoteWithSemanticDedup` 内部可禁用），不影响 develop 其他功能

---

## 2. 需要改动的文件与位置

### 2.1 `src/main/features/recall/capture-service.ts`

**位置 1：`automaticallyApplyReviewableCandidates`（1234 行）**

现在的两处调用（1262、1273 行）：
```ts
const applied = await autoApplyRecallCandidate(userId, candidate.id);
```
改为：
```ts
const applied = await promoteWithSemanticDedup(userId, candidate.id);
```

- 1262 行：候选状态 `confirmed` 但资产/回执缺失的恢复路径
- 1273 行：常规自动晋升路径
- 两处都替换；`promoteWithSemanticDedup` 内部对 `confirmed` 候选复用 `promoteRecallCandidate`（与 `autoApplyRecallCandidate` 的 confirmed 分支一致）

**位置 2：import（22 行）**
```ts
autoApplyRecallCandidate,
```
→
```ts
promoteWithSemanticDedup,   // 新共享函数（替代 autoApplyRecallCandidate 在此文件的角色）
```
（`autoApplyRecallCandidate` 保留导出，供其他调用方/测试使用；KStar 封装也走 `promoteWithSemanticDedup`）

**不改**：`queueRecallCaptureFromTerminal`、`runRecallCapture`、`selectCaptureMessages`、`parseRecallCaptureOutput`、`saveRecallCandidate` 调用（1534 行）——提取与入库保持原样。

### 2.2 `src/main/features/recall/candidate-service.ts`

**只新增，不改既有逻辑**：
- 新增 `promoteWithSemanticDedup(userId, candidateId, opts)`：
  ```ts
  export async function promoteWithSemanticDedup(
    userId: string,
    candidateId: string,
    opts: { threshold?: number } = {},
  ): Promise<{ candidate: RecallCandidateRecord; asset?: RecallAbilityAssetRecord; mergedIntoAssetId?: string }>
  ```
  逻辑：
  1. 读候选（`readRecallCandidate`）
  2. 若候选已 `confirmed` 且资产/回执完整 → 幂等返回（与 autoApply 一致）
  3. **晋升前资产语义查重**：`findSemanticDuplicate(userId, { judgment, sourceRefs, excludeAssetIds })`（新共享函数，§2.3），阈值默认 0.85
  4. 命中已有资产 → 按质量融合（§2.4）：
     - 已有质量更高/相当 → 证据并入已有资产，候选标记 `mergedIntoAssetId`，返回已有资产
     - 新候选质量更高 → 生成 update 候选（`targetAssetId` = 已有资产），**不自动写资产**，返回 `{ candidate: updateCandidate }`（进"待我处理"）
     - 互补 → 融合 judgment + 证据全并 → 生成 update 候选（同上）
  5. 未命中 → 走原 `autoApplyRecallCandidate` / `promoteRecallCandidate` 逻辑

- **不改**：`saveRecallCandidate`（指纹去重）、`promoteRecallCandidate`（用户确认路径）、`autoApplyRecallCandidate`（保留，供回滚）

### 2.3 新增共享文件 `src/main/features/recall/similarity.ts`

| 函数 | 职责 |
|---|---|
| `cosineScore(left, right)` | 从 context-projection.ts:232 提取（原处改为 re-export） |
| `embedForDedup(userId, text)` | kb_embed.embedQuery + LRU 缓存（judgment→vector，按 userId） |
| `findSemanticDuplicate(userId, input)` | 遍历候选池 + 资产库，返回 `{ match, score, kind: 'candidate'|'asset' }` 最高者 |
| `assetQualityScore(record)` | §4.9 五维质量评分（成熟度/内容/证据/时效/风险） |

### 2.4 融合逻辑（`similarity.ts` 或 candidate-service 内）

```
mergeByQuality(userId, incoming, existing):
  scoreIn = assetQualityScore(incoming)
  scoreEx = assetQualityScore(existing)
  if scoreIn - scoreEx >= 0.10:
    → update 候选（targetAssetId=existing.id，内容=incoming+existing证据）
  elif 互补（各含对方独有结构）:
    → update 候选（judgment=主体+对方独有细节，mergedFrom=[both]）
  else:
    → 证据并入 existing，incoming 标记 mergedIntoAssetId
```

---

## 3. 行为变化对照（改动前后）

| 场景 | 改动前（capture 现状） | 改动后 |
|---|---|---|
| capture 候选晋升，资产库无重复 | 直接写资产 | 相同（查重未命中） |
| capture 候选晋升，资产库已有同语义资产（KStar 先沉淀） | **双写**（两资产并存） | 按质量融合：证据并入 or update 候选 |
| 两个 capture run 提取同语义、措辞不同 | 各晋升 → 双资产 | 后者命中前者 → 融合，一份 |
| 用户手动 promote（"待我处理"页） | 精确查重 | **不变**（用户路径不接语义查重，尊重用户显式决定；或可选接入——见 OQ） |
| capture 提取/质量评估/状态机 | 不变 | 不变 |
| 失败处理（failedCandidateIds） | 不变 | 不变 |

---

## 4. 兼容性与回归

- **数据兼容**：不迁移存量候选/资产；只影响新晋升
- **接口兼容**：`autoApplyRecallCandidate` / `promoteRecallCandidate` 保留导出，测试与第三方调用不受影响
- **行为兼容**：capture 自动晋升的触发条件不变；仅多一道查重（未命中时行为一致）
- **性能**：晋升前一次 embedQuery + 资产库遍历（当前 9 资产，可忽略）；LRU 缓存 + 池上限降级（主文档 §4.5）
- **回归测试**：capture-service 现有 40 项测试 + candidate-service 现有测试全过；新增 §7 用例（主文档）

---

## 5. 测试计划（capture 侧）

| 用例 | 断言 |
|---|---|
| capture 晋升未命中查重 | 行为与改动前一致（资产正常创建） |
| capture 晋升命中已有资产（KStar 先沉淀） | 不新建资产；证据并入 or update 候选 |
| 两个 capture run 同语义措辞不同 | 后者融合前者，仅一份资产 |
| 用户手动 promote | 不受影响（显式决定） |
| 恢复路径（confirmed 缺资产/回执） | promoteWithSemanticDedup 幂等恢复 |
| 回归 | capture-service + candidate-service 全部现有测试 |

---

## 6. 与 KStar 线的改动边界

| 文件 | 归属 |
|---|---|
| `src/main/features/kstar/direct-experience-assets.ts` | KStar 线（主文档 §3.2.1） |
| `src/main/features/kstar/task-level-precipitation.ts` | KStar 线（主文档 §3.2.3） |
| `src/main/features/kstar/task-closure.ts` | KStar 线（主文档 §5 自动闭环） |
| `src/main/features/group_chat/bus.ts` | KStar 线（recoverPendingAutoClosures 启动） |
| `src/main/features/recall/similarity.ts` | **共享新增**（双方使用） |
| `src/main/features/recall/candidate-service.ts` | **共享新增**（promoteWithSemanticDedup，不改既有） |
| `src/main/features/recall/capture-service.ts` | **capture 线改动**（仅 2 处调用 + import） |

---

## 7. 开放问题（capture 侧）

| ID | 问题 | 默认处理 |
|---|---|---|
| C-OQ-1 | 用户手动 promote 是否也接语义查重 | 默认不接（尊重显式决定）；可加选项 `semanticDedup: true` |
| C-OQ-2 | capture 提取候选的 `risk` 判定是否复用质量评分的风险维 | 复用 capture 现有 quality 评估，不重复 |
| C-OQ-3 | `promoteWithSemanticDedup` 失败时 capture 的 failedCandidateIds 语义 | 保持（失败候选进 failed，可重试） |
