---
name: feature-prioritization
description: "为问题、功能或方案选择合适的优先级框架，基于影响、触达、投入、风险、战略匹配和证据充分度输出排名、敏感性分析与人工决策点。用于Backlog、版本范围和投资取舍；不把缺失数据伪装成精确分数。"
---

# 功能优先级决策

## 目标

把优先级从单一分数升级为可解释、可复核、能暴露不确定性的决策。

## 开始前

至少确认：

- 产品目标、成功指标和时间范围
- 候选问题/方案及证据
- 资源、依赖、风险和决策约束

缺少会改变结论的关键输入时，提出最少必要问题；若用户要求继续，使用 `未知/TBD`，不要补造。

## 工作流

1. 先确认排序对象是问题、方案还是需求；不同对象不得混在同一量表。
2. 选择框架：问题机会用Opportunity Score；快速方案筛选用ICE；大规模投入用RICE；多约束共识用加权矩阵；范围承诺可用MoSCoW。
3. 定义每个字段的单位、时间窗、评分锚点和数据来源；缺失值保持为空并降低置信度。
4. 计算基线结果，同时单列战略匹配、风险、依赖、合规和硬门槛；硬门槛不被总分抵消。
5. 做敏感性分析：改变权重、置信度或投入估计，识别排名稳定项和易翻转项。
6. 输出推荐、取舍、暂缓项、不可比项、最低成本验证和需要决策人确认的例外。

## 专业判断规则

- 优先排序问题，再评估解决方案。
- 框架用于组织判断，不替代决策。
- 置信度必须来自证据质量，不得用于美化偏好。
- 总分接近或样本不同质时报告区间/梯队，不伪造精确顺序。

## 输出契约

必须返回：

- 框架选择与量纲定义
- 评分/证据矩阵
- 基线排名与取舍
- 敏感性分析
- 人工决策与验证项

所有关键结论都标为 `事实 / 推断 / 假设 / 建议 / 待决策` 之一，并保留证据ID或缺口。只返回正式资产候选，不直接覆盖PRD、路线图或长期认知资产。

## 失败与降级

- 来源不可访问：列出已完成部分、缺失来源和对结论的影响。
- 权限或敏感度不满足：停止对应读取或外部动作，返回所需授权。
- 数据互相冲突：并列冲突及适用条件，不自行裁决为单一事实。
- 预算耗尽：返回当前证据、未完成步骤和可安全续跑点。

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：需要“把优先级从单一分数升级为可解释、可复核、能暴露不确定性的决策。”，并已提供或授权“产品目标、成功指标和时间范围”与“候选问题/方案及证据”等最小业务输入。
- `do_not_use_when`：缺少或未授权“产品目标、成功指标和时间范围”；“候选问题/方案及证据”的对象、范围或版本无法确认；任务不属于“feature-prioritization”职责；或请求违反专属判断规则“优先排序问题，再评估解决方案。”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行feature-prioritization，输出框架选择与量纲定义并保留证据定位。`
- `negative_examples`：`没有产品目标、成功指标和时间范围，仍请直接完成feature-prioritization。`；`候选问题/方案及证据尚未确认，但请直接定稿框架选择与量纲定义。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- SKILL-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)。需要输出模板、质量Gate和示例时，以该文件为准。

## 来源与适配

主体适配自 phuryn Prioritize Features 与 Prioritization Frameworks；增加证据充分度、量纲校验、敏感性和硬门槛。 文件级来源、许可证、SHA和修改记录见包根目录 `provenance/components.yaml` 与 `THIRD_PARTY_NOTICES.md`。
