# 六盒架构：本体三盒 × 世界模型三盒

> 状态：设计基线（2026-08-16）
> 原则：**本体是持久层（你是谁），世界模型是瞬态重组体（你现在什么状态、这次任务需要什么）**。
> 世界模型不存在"一份稳定的 world_model.json"——它每次任务边界按当前会话与任务重新组装，面对的是复杂多变场景。

---

## 0. 一句话模型

```
本体 (persistent, 慢变)  ──►  世界模型 (ephemeral, 每次任务重组)  ──►  f(K,S,T) → (A_hat, R_hat)
     三盒：概念/事实/规则              三盒：概念集/状态快照/适用规则              预测：预期A + 预期R
```

- **本体**：跨会话存在，描述"用户是谁、知道什么、按什么规则行事"。手动/沉淀写入，慢变。
- **世界模型**：在任务边界（`request_projection` → `commit_forecast`）由宿主**重新组装**，用完即随 forecast 记录冻结；下一任务重新组。
- 世界模型是**本体的投影切片 + 实时状态 + 任务上下文**的合成体，不是独立持久实体。

---

## 1. 本体三盒（持久层，慢变）

| 盒 | 定义 | 内容 | 数据形态（现状） | 谁写 | 变化频率 |
|---|---|---|---|---|---|
| **本体 T-Box** | 概念/分类学定义 | 分组台账、字段词汇表、字段类型（值/关系） | `groups.md` 台账 + `listGroupFields` 词汇 | 手动 / 模板安装 / 迁移脚本 | 慢（新增概念才变） |
| **本体 A-Box** | 事实断言 | 字段值（`上午专注`）、流水条目（`2026-08-14 完成迁移`） | 分组文件字段区/流水区（FieldValue + 来源标记） | 手动 / 对话沉淀 / KStar 路由 | 中（事实追加） |
| **本体 R-Box** | 业务规则 + ID 映射 | 字段值写成 `A → B` 即关系规则（值形状驱动；`isRelation` 声明为可选显式信号，内置模板暂无） | ✅ `recall/ontology-rules.ts`：`loadOntologyRules` 遍历分组解析 `A → B` 值 → `{id: ontr-*, groupId, field, subject, object}`，进入世界模型 K | 手动（写关系值）/ 沉淀 | 慢 |

要点：
- 本体的 T/A 两盒已有实现；**R-Box 缺失**——本体目前只存"是什么"，不存"因此该怎么办"。
- 本体 R-Box 与资产 CausalRule 的关系：本体规则是**持久、跨任务**的业务规则（如"用户所有任务默认要附证据"）；能力资产规则是**经验教训**（从 ΔR 沉淀）。两者都是世界模型 R-Box 的候选来源。

## 2. 世界模型三盒（瞬态层，每次任务重组）

| 盒 | 定义 | 内容（本次任务） | 数据形态（现状） | 谁组 | 变化频率 |
|---|---|---|---|---|---|
| **世界模型 T-Box** | 任务概念集 | 投影冻结的资产（检索选中的能力资产 + 本体资产 `onto-*`）+ 本体分类学子集 | `simulationInput.k`：`abilityAssets` + `ontologyAssets` + `ontologyTaxonomy` | 宿主（`loadCommittedProjectionKnowledge`） | 每任务 |
| **世界模型 A-Box** | 当前状态快照 | 环境（workspace/model/tools）、核心（群聊/kstar/recall 状态）、技能、本体统计 | `WorldModelSnapshot`（`collectWorldSnapshot`） | 宿主（forecast-commit） | 每任务（可扩展为每次工具调用后刷新） |
| **世界模型 R-Box** | 本次适用规则 | 冻结资产的 CausalRule 子集 → PredictedRisk（F002 确定性推导） | `simulationInput.k.rules` + `applyCausalRules` | 宿主 | 每任务 |

要点：
- 世界模型三盒**全部由宿主在任务边界组装**，组装函数：`assembleWorldModel(userId, {projectionId, taskText, workspaceId, …})`。
- 组装输入 = 本体（持久切片）+ 实时状态（探测）+ 任务文本；组装产物 = `WorldModelSimulationInput {k, s, t}`。
- 重组时机（现状）：`request_projection`（检索+冻结）→ `commit_forecast`（组装 K+S+T → Commander 预测）。
- **重组频率可升级**：当前是"每任务一次"；未来可"每次工具调用后刷新 A-Box"（Hook 式），但**T-Box/R-Box 仍按任务冻结**——快变的是状态，不是概念。

## 3. 重组机制（核心设计）

```
用户消息 / 任务边界
      │
      ▼
request_projection ──► 检索：资格过滤 → 语义 Top-N（双信号）→ 冻结 assetIds+versions
      │
      ▼
commit_forecast ──► 组装世界模型（每任务一次）：
      │                T-Box ← 冻结资产快照 + 本体资产 + 本体分类学（loadCommittedProjectionKnowledge）
      │                A-Box ← collectWorldSnapshot（实时探测）
      │                R-Box ← 冻结资产的 CausalRule → PredictedRisk
      ▼
      f(K,S,T) ──► Commander 生成 2–4 候选 (A_hat, R_hat) ──► 宿主校验/重算/选优 ──► forecast 记录（含冻结的 simulationInput）
```

- **世界模型的"不稳定"是特性**：每个任务的 K/S/T 都不同，forecast 记录里冻结的是**当时**的重组结果；下一次任务重新组。
- **本体提供稳定锚点**：跨任务不变的只有本体（你是谁/你的规则），世界模型从本体取切片 + 叠加实时状态。

## 4. 现状差距清单

| # | 差距 | 影响 | 优先级 |
|---|---|---|---|
| ~~1~~ ✅ | ~~本体 R-Box 缺失~~ 已实现（`ontology-rules.ts`）：值形状驱动（`A → B`），`isRelation` 声明为可选信号；进入 `simulationInput.k.ontologyRules`，与资产 CausalRule（ΔR 教训）并列 | 本体现在有了"因此该怎么办" | — |
| 2 | 世界模型 T-Box 中的本体资产（`onto-*`）与本体三盒的对应关系未显式化 | 本体的 A-Box 事实 vs 世界模型的 onto-* 资产重复承载 | P2（映射文档） |
| 3 | A-Box 只在 forecast 时探测一次 | 长任务中状态可能过时 | P2（工具调用后刷新，Hook） |
| 4 | 重组函数分散在 forecast-commit / projection-knowledge / world-model 三处 | 无单一 `assembleWorldModel` 入口 | P2（收敛命名） |
| 5 | 世界模型无独立 T-Box Schema 文件（TS 接口即 Schema） | 可接受，接口即契约 | 不改 |

## 5. 建议落地顺序

1. ✅ **本体 R-Box 已实现**（`ontology-rules.ts`）：值形状驱动——字段值 `A → B` 即业务规则（`ontr-*`），进入世界模型 K 的 `ontologyRules`；`isRelation` 显式声明为可选信号。
2. **收敛重组入口**（P2）：`assembleWorldModel(userId, input)` 封装 投影知识 + 快照 + 规则，forecast-commit 调用它，命名即文档。
3. **A-Box 刷新 Hook**（P2）：工具调用后增量刷新快照（保留每任务 T/R 冻结语义）。
