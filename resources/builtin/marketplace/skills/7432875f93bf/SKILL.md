---
name: acceptance-evaluation
description: "为确定性功能和非确定性Agent分别设计验收场景、Golden Set、评分器、能力与信任安全指标、重复运行、回归分区和SHIP/ITERATE/BLOCK Gate。用于PRD验收、AI功能Evaluation或发布评审；没有真实执行证据时不得宣称通过。"
---

# 验收与Evaluation设计

## 目标

在开发前定义什么算好、如何测、失败如何归因，以及什么证据允许发布。

## 开始前

至少确认：

- 需求ID、价值主张与风险
- 用户流程、边界、工具/数据/权限
- 可用测试环境、真值来源和评审人

缺少会改变结论的关键输入时，提出最少必要问题；若用户要求继续，使用 `未知/TBD`，不要补造。

## 工作流

1. 按影响、可逆性、数据敏感度和自治程度划分风险Tier，先定义硬失败条件。
2. 确定性模块按目标、前置条件、角色、步骤、可观察结果生成Happy/Edge/Error/Permission/Recovery场景。
3. Agent模块分开能力评测与信任安全评测，定义业务问题场景、工具调用、Grounding、拒答、隐私和Graceful Failure。
4. 建立Golden Set：真实/合成来源、版本、代表性、反例、对抗比例和人工真值Owner；建议约50%主路径、30%边界、20%对抗。
5. 为每个标准选择Exact/规则/语义Judge/人工评分，写清rubric、阈值、样例和冲突裁决。
6. 对非确定结果重复运行，记录均值、方差和失败集中度；区分Eval设置问题与产品/Agent质量问题。
7. 映射CogSeed E0–E5，输出Gate与证据包；未真实执行的层保持not_run。

## 专业判断规则

- 功能验收与Agent质量Evaluation不可混为一个通过率。
- 能力指标和信任安全指标分开报告，安全硬失败不得被平均分抵消。
- Golden样例必须有来源和真值Owner。
- 结构校验通过不等于任务质量或发布Gate通过。
- 没有真实运行证据时，E0–E5对应层必须保持not_run；业务内容阻塞另列Gate，不冒充Eval状态。

## 输出契约

必须返回：

- 风险与验收策略
- 测试场景与Golden Set
- 评分器/rubric/阈值
- E0–E5映射与发布Gate
- 执行证据和失败归因模板

所有关键结论都标为 `事实 / 推断 / 假设 / 建议 / 待决策` 之一，并保留证据ID或缺口。只返回正式资产候选，不直接覆盖PRD、路线图或长期认知资产。

## 失败与降级

- 来源不可访问：列出已完成部分、缺失来源和对结论的影响。
- 权限或敏感度不满足：停止对应读取或外部动作，返回所需授权。
- 数据互相冲突：并列冲突及适用条件，不自行裁决为单一事实。
- 预算耗尽：返回当前证据、未完成步骤和可安全续跑点。

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：需要“在开发前定义什么算好、如何测、失败如何归因，以及什么证据允许发布。”，并已提供或授权“需求ID、价值主张与风险”与“用户流程、边界、工具/数据/权限”等最小业务输入。
- `do_not_use_when`：缺少或未授权“需求ID、价值主张与风险”；“用户流程、边界、工具/数据/权限”的对象、范围或版本无法确认；任务不属于“acceptance-evaluation”职责；或请求违反专属判断规则“功能验收与Agent质量Evaluation不可混为一个通过率。”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行acceptance-evaluation，输出风险与验收策略并保留证据定位。`
- `negative_examples`：`没有需求ID、价值主张与风险，仍请直接完成acceptance-evaluation。`；`用户流程、边界、工具/数据/权限尚未确认，但请直接定稿风险与验收策略。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- SKILL-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)。需要输出模板、质量Gate和示例时，以该文件为准。

## 来源与适配

主体适配自 Microsoft Eval Guide 与 phuryn Test Scenarios；移除特定运行时，映射到CogSeed E0–E5和跨Session/Agent连续性。 文件级来源、许可证、SHA和修改记录见包根目录 `provenance/components.yaml` 与 `THIRD_PARTY_NOTICES.md`。
