# KSTAR Evolution（进化记录）

Skill: `personal-ontology-candidate-builder`  ·  Level: `L3`  ·  Owner: `Mate Agent Team`

本技能在重要候选提炼运行前记录预测（A_hat/R_hat），执行后记录实际结果并计算差异（DeltaA/DeltaR），作为学习信号。

## KSTAR 框架

**K（知识）**:
- 个人本体 TBox/RBox/ABox 切片（`ontology/personal_ontology/`）。
- 本技能包（SKILL.md + references + schemas.json）。
- 当前候选池与记忆版本。
- 记忆与回放引用。

**S（情景）**:
- 用户请求把个人记忆整理成结构化候选。
- 约束：`local_only`、`candidate_only`、用户确认制、脱敏必须、来源必带。

**T（任务）**:
- 产出有用的候选更新（candidates.md）和阻断项（blocked_items.md）。
- 保留来源追溯与边界声明。

**ProblemSpace（问题空间）**:
- 算子：分类记忆、识别候选类型、判断去向、验证脱敏、验证来源支撑、阻断边界违规。
- 约束：无未经确认的写入、无团队共享输出、无未脱敏敏感数据。

## 预测记录（Forecast Required）

重要提炼前记录:
- `A_hat`：计划执行的提炼与校验动作。
- `R_hat`：预期候选数、阻断数、置信度分布、用户确认负担、预期边界风险。
- `FeedbackMountPoint`：出错时反馈应挂载的位置（类型误判/来源不足/脱敏失败/过度泛化）。

## 实际记录（Actual Required）

执行后记录:
- `A`：实际采取的动作。
- `R`：接受候选、驳回候选、阻断项、用户意见。
- `DeltaA`：预期动作是否实际执行。
- `DeltaR`：结果偏差（类型判错、缺来源、脱敏漏检、规则过度泛化）。
- `DeltaA` 门控 `DeltaR`（动作没执行到位时，结果偏差不可信）。

## 归因目标（Attribution Targets）

- 类型判错 → SKILL.md 或 TBox。
- 边界漏拦 → RBox 或治理边界。
- 敏感数据漏检 → 治理边界或输出契约。
- 缺来源追溯 → 工作流或输出契约。
- 用户觉得输出太重 → 工作流或评测。

## 更新候选边界（Update Candidate Boundary）

单次 episode 只产生候选更新，不直接改技能/本体。持续变更需要:
- 至少 3 条可信 KSTAR episode。
- EvolutionCampaign（回放/回归 + `best` checkpoint 选择）。
- `auto_adopt=false`（候选不自动生效）。

## 运行台账

- 候选与阻断：`$ORKAS_WORKSPACE_ROOT/$ORKAS_UID/local/ontology_candidates/`（candidates.md / blocked_items.md / kstar_episodes.md）。
- 台账为人读 markdown，追加不覆盖。
