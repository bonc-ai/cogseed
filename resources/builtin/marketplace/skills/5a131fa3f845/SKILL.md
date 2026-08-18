---
name: requirement-evidence
description: "把访谈、工单、销售反馈、数据与功能请求综合为可追溯的问题主题、证据账本和待验证假设。用于需求发现、批量反馈分析、需求澄清或客户诉求评估；不得把转述、推断或模拟反馈冒充真实用户证据。"
---

# 需求证据综合

## 目标

从多来源材料中识别用户问题与机会，不让解决方案措辞替代问题证据。

## 开始前

至少确认：

- 决策目标或待回答问题
- 一个或多个带来源定位的需求材料
- 产品目标、用户分群与已确认规则（如有）

缺少会改变结论的关键输入时，提出最少必要问题；若用户要求继续，使用 `未知/TBD`，不要补造。

## 工作流

1. 定义本次决策问题、范围、时间窗口和证据门槛；范围不清时先澄清。
2. 建立证据账本：给每条原始材料分配证据ID，记录来源类型、用户/角色、日期、原文定位和是否为一手证据。
3. 把每条内容拆为表面请求、观察到的问题、期望结果、当前替代方案、约束和解决方案建议；缺失项标为未知。
4. 按问题/JTBD而非功能名称聚类；保留反例、冲突证据和无法归类项，不强行合并。
5. 为主题判断频率、影响范围、痛苦强度、战略匹配与证据质量；数字只使用可追溯数据。
6. 输出事实、推断、假设、建议四层结论，并为高风险假设给出最低成本验证动作。

## 专业判断规则

- 客户可以描述问题和期望结果，但不直接决定产品解法。
- 重复提及不等于高价值；样本偏差和客户权重必须显式。
- 没有原始定位的结论不得标为事实。
- 相互冲突的证据不得用平均化叙述掩盖。

## 输出契约

必须返回：

- 需求主题矩阵
- 证据账本与引用
- 冲突/反例清单
- 假设与验证计划
- 开放问题与候选认知资产

所有关键结论都标为 `事实 / 推断 / 假设 / 建议 / 待决策` 之一，并保留证据ID或缺口。只返回正式资产候选，不直接覆盖PRD、路线图或长期认知资产。

## 失败与降级

- 来源不可访问：列出已完成部分、缺失来源和对结论的影响。
- 权限或敏感度不满足：停止对应读取或外部动作，返回所需授权。
- 数据互相冲突：并列冲突及适用条件，不自行裁决为单一事实。
- 预算耗尽：返回当前证据、未完成步骤和可安全续跑点。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要“从多来源材料中识别用户问题与机会，不让解决方案措辞替代问题证据。”，并已提供或授权“决策目标或待回答问题”与“一个或多个带来源定位的需求材料”等最小业务输入。
- `do_not_use_when`：缺少或未授权“决策目标或待回答问题”；“一个或多个带来源定位的需求材料”的对象、范围或版本无法确认；任务不属于“requirement-evidence”职责；或请求违反专属判断规则“客户可以描述问题和期望结果，但不直接决定产品解法。”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行requirement-evidence，输出需求主题矩阵并保留证据定位。`
- `negative_examples`：`没有决策目标或待回答问题，仍请直接完成requirement-evidence。`；`一个或多个带来源定位的需求材料尚未确认，但请直接定稿需求主题矩阵。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- NSEAP-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)。需要输出模板、质量Gate和示例时，以该文件为准。

## 来源与适配

方法主干适配自 phuryn/pm-skills 的 Analyze Feature Requests 与 Summarize Customer Interview；增加 CogSeed 证据分层、冲突处理和候选写入边界。 文件级来源、许可证、SHA和修改记录见包根目录 `provenance/components.yaml` 与 `THIRD_PARTY_NOTICES.md`。
