---
name: product-metrics
description: "设计North Star、输入、产品健康、AI质量与商业指标，明确公式、分母、时间窗、数据源、Owner、阈值、护栏和复盘节奏。用于指标体系、Dashboard、实验或发布Gate设计；不在数据不可得时制造虚假精确目标。"
---

# 产品指标设计

## 目标

把产品价值主张转成可计算、可解释、可行动并能防止局部优化的指标体系。

## 开始前

至少确认：

- 用户价值与业务模式
- 核心用户旅程和产品阶段
- 现有数据源、埋点、目标和约束

缺少会改变结论的关键输入时，提出最少必要问题；若用户要求继续，使用 `未知/TBD`，不要补造。

## 工作流

1. 明确指标服务的决策、对象、产品阶段与评审节奏；先检查数据可得性。
2. 提出单一North Star候选并用客户价值、可理解、可行动、可持续、愿景匹配、可量化和领先性检验。
3. 构建四层：North Star；3–5个输入指标；质量/留存/可靠性/信任安全健康指标；收入、成本或续费商业指标。
4. 为每个指标写指标卡：名称、问题、公式、分子、分母、时间窗、去重、分群、数据源、Owner、刷新频率和已知偏差。
5. 定义基线、目标、预警阈值、护栏、反作弊和分群切片；说明阈值证据或标TBD。
6. 将指标连接到实验、版本和发布Gate，建立异常→诊断→行动→复盘闭环。

## 专业判断规则

- North Star是客户获得价值的单一指标，不等于收入、OKR或指标列表。
- 活动量不自动等于价值；必须说明价值代理关系。
- 平均值必须配合关键分群，防止掩盖弱势用户。
- AI产品同时跟踪任务成功、采纳/纠正、引用/安全、延迟和成本。

## 输出契约

必须返回：

- 指标树/指标分层
- 完整指标字典
- 数据可得性与埋点缺口
- 目标/阈值/护栏
- 实验与发布Gate映射

所有关键结论都标为 `事实 / 推断 / 假设 / 建议 / 待决策` 之一，并保留证据ID或缺口。只返回正式资产候选，不直接覆盖PRD、路线图或长期认知资产。

## 失败与降级

- 来源不可访问：列出已完成部分、缺失来源和对结论的影响。
- 权限或敏感度不满足：停止对应读取或外部动作，返回所需授权。
- 数据互相冲突：并列冲突及适用条件，不自行裁决为单一事实。
- 预算耗尽：返回当前证据、未完成步骤和可安全续跑点。

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：需要“把产品价值主张转成可计算、可解释、可行动并能防止局部优化的指标体系。”，并已提供或授权“用户价值与业务模式”与“核心用户旅程和产品阶段”等最小业务输入。
- `do_not_use_when`：缺少或未授权“用户价值与业务模式”；“核心用户旅程和产品阶段”的对象、范围或版本无法确认；任务不属于“product-metrics”职责；或请求违反专属判断规则“North Star是客户获得价值的单一指标，不等于收入、OKR或指标列表。”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行product-metrics，输出指标树/指标分层并保留证据定位。`
- `negative_examples`：`没有用户价值与业务模式，仍请直接完成product-metrics。`；`核心用户旅程和产品阶段尚未确认，但请直接定稿指标树/指标分层。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- SKILL-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)。需要输出模板、质量Gate和示例时，以该文件为准。

## 来源与适配

主体适配自 phuryn Product Metrics Dashboard 与 North Star Metric；增加B端/AI质量、口径治理、反作弊和Gate映射。 文件级来源、许可证、SHA和修改记录见包根目录 `provenance/components.yaml` 与 `THIRD_PARTY_NOTICES.md`。
