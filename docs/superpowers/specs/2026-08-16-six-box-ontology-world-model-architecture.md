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

## 5. 落地状态

1. ✅ **本体 R-Box 已实现**（`ontology-rules.ts`）：值形状驱动——字段值 `A → B` 即业务规则（`ontr-*`），进入世界模型 K 的 `ontologyRules`；`isRelation` 显式声明为可选信号。
2. ✅ **最小规则引擎**（`recall/rule-engine.ts`，对齐参考 `_ONTOLOGY_ENGINE`）：forecast 时按任务文本 token 匹配评估本体规则（ontr-*）与资产 ΔR 教训（CausalRule cause/effect/mitigation），命中子集进 `simulationInput.k.matchedRules`——Commander 只对着"本次任务真正适用的规则"推理（上限 12 条，确定性、无副作用）。
3. ✅ **学习回流阈值门**（对齐参考 `|ΔR|≥0.15`）：`clearsPrecipitationGate`——数值 ΔR/ΔA ≥0.15、或明确 better/worse-than-expected、或高置信具体 gap（knowledge/rule/template/skill + reason）才沉淀；"met_expected + ~0 delta" = 无偏离 = 不沉淀（噪声门）。单集与任务级沉淀同时生效。
4. ✅ **复盘从"猜"到"推理"（差异→原因→资产）**：有 forecast 时 `reconcileWorldModel` 仍确定性**测量**差异（deltaA/deltaR + 动作/结果细节），但归因与沉淀内容改由模型**推理**——差异详情 + 预测 + 选中资产类型喂给模型，产出 attribution/reason/**lesson**（"为什么差 + 什么可复用"）；lesson 成为沉淀 judgment（替代固定模板句）；模型不可用时降级到确定性归因（诚实数字 + 机械标签）。
5. ✅ **五类认知来源全量进入复盘上下文**：差异 a/r 的演化依据 PRD v2 全部来源——`conversation`（会话+消息）、`artifact_file`（产物/附件，替换 legacy artifact）、`execution_evaluation`（执行评估）、`user_teaching_signal`（active 教学信号，closure 时宿主解析）、`authorized_external_system`（connector 引用，按需附加）——episode 证据携带全量来源，模型推理归因时看到的不只是对话文本。
6. ✅ **路由提升（实机确诊：普通措辞被默认 skip）**：实机验证发现 Commander 默认 `kstar:skip`，常规用户消息（"审查一下 X"）不进 KStar 线 → 无投影/预测/比较。两层修复：
   - **层 1 任务意图检测**（`kstar/task-intent.ts`）：宿主确定性检测任务形消息（非寒暄/状态查询 + 目标动词 + 长度门槛），检测到则向 Commander 注入 advisory 路由提示（`## Host routing hint`），引导其调 `kstar_control`——不强制、零写入。
   - **层 2 派发即任务**：`dispatch_to`/`hand_off_to`/具名 `run_worker` 时若无可跟踪任务，宿主自动 `upsert_state` 建任务 + 自动确认投影（workspace_policy 线），并让该次派发通过门禁（`allowHostAutoTracked`），Commander 随后补 `commit_forecast`。派发即任务信号，不依赖用户措辞。
7. ✅ **任务闭环判定 = 用户下一条消息（模型判断延续 vs 新需求，同步版）**：`hostRouteTaskTurn` 里有 open 任务时，宿主**同步询问 Commander**（`kstar_continuation_judge` → `<kstar-judge>{"continuation":true|false}</kstar-judge>`，30s 超时）判断这条消息是延续还是新需求；**false（新需求）→ 旧任务走 finish 收尾 + requirement 级沉淀 → 本消息建新任务**；true/超时 → 延续不动作（超时默认延续，绝不误关任务）。用户满意→发新需求→旧任务闭环沉淀；不满意→继续改→未闭环。：闭环不是技术信号（会话静止/Commander finish），而是**用户使用行为**——用户满意后会**继续发新需求**（不再提旧任务），不满意会**继续发修改意见**。实现：Commander 在回复中带 `<kstar-closure>{"new_task":true|false}</kstar-closure>` 标记（模型用完整上下文判断"延续 vs 新"）；宿主 turn 后解析标记，new_task → 走 `finish` 控制路径（requirement→waiting_review + task→closing + **requirement 级沉淀**）；延续/沉默 → 不动作。用户满意→发新需求→旧任务闭环沉淀；不满意→继续改→未闭环。
8. ✅ **沉淀时机 = 整个任务闭环（不是每次 run）**：closure（每次 run 终态）**只复盘**——落 review + 标记 extraction-run，**不沉淀**。沉淀唯一入口是 **requirement 级聚合**（`precipitateRequirementLevel`，在 `finish`/`abandon`/新任务切换时触发）：读 requirement 全部 episode 的 review → 聚合工具链/最强信号/去重证据 → **一条资产直接入能力资产**。任务中途的 run 静止不产生碎片资产，闭环完成才沉淀完整教训。
8. ✅ **沉淀直通能力资产（跳过认知沉淀候选线）**：KStar 线沉淀**不再走** `saveRecallCandidate` → pending_review 候选审查线——复盘 lesson **直接** `createSystemAbilityAsset` 进能力资产（单集 + 任务级聚合都是 direct-only）。幂等由内容寻址保证（同 judgment+证据 → 同资产 id），extraction-run 只需标记"已处理"（created 即终态，无候选集完整性校验）。候选审查线整体从 KStar 线移除。
8. ✅ **确定性宿主路由（治本：路由不再依赖模型自觉）**：实机两次证明模型可能空参调用/跳过 kstar_control（`input_bytes=0` 3 次失败）。改为：任务形用户消息（层 1 检测，确定性）→ **宿主直接** `upsert_state` + `request_projection`（自动确认投影）——Commander 不再需要调这两个。模型唯一 KStar 职责 = `commit_forecast`（预测本身），由门禁 + next_step 契约双保险。寒暄零写入保留（检测过滤 + env 开关 `ORKAS_KSTAR_HOST_ROUTING=0` 供测试/降级）。
8. ✅ **复盘确认取消——自进化由 Agent 实现**（产品定夺：用户不参与预测也不观察执行内部，无法核对预期/实际差异）：`startGroupKstarClosure` 不再发布 review 确认卡片；模型低置信不再暂停等用户（review 恒为 `inferred`，confidence 仅喂沉淀门——低置信自动不沉淀）；证据不足的 review 仍记录（审计轨迹）但永不暂停、永不沉淀。`kstar.review.confirm` IPC 保留（兼容），但主链路不再向用户发起确认。
8. ✅ **沉淀方向明确：KStar 线只写能力资产**——`routeConfirmedKstarCandidate`（KStar 写本体入口，从未接入的死代码）已删除；本体更新归属本体线（`personal_ontology_candidates.confirmCandidate` + LLM 路由，独立模型/独立流程）。KStar 闭环**用本体**（读入 K）但**不更新本体**。
4. **收敛重组入口**（P2）：`assembleWorldModel(userId, input)` 封装 投影知识 + 快照 + 规则，forecast-commit 调用它，命名即文档。
5. **A-Box 刷新 Hook**（P2）：工具调用后增量刷新快照（保留每任务 T/R 冻结语义）。
