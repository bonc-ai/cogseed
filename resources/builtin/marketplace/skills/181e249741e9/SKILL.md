---
name: milestone-plan
description: "把WBS转成有依赖逻辑、容量约束、关键路径和缓冲的可预测计划。 用于项目经理的专业任务；当关键证据缺失、需要越权或涉及正式写入时停止并请求确认。"
---

# 里程碑与计划

## 目标

把WBS转成有依赖逻辑、容量约束、关键路径和缓冲的可预测计划。

## 开始前

确认任务目标、授权来源、版本、输出用途和成功标准。会改变结论的关键输入缺失时提出最少必要问题；若继续，使用 `未知/TBD`，不得补造。

## 工作流

1. 把里程碑定义为决策或验收事件，而非任意日期
2. 建立FS/SS/FF依赖网络，记录外部依赖、日历和资源容量
3. 计算关键与近关键路径，设置风险缓冲并形成基线/情景
4. 每次更新比较基线、实际与预测，解释偏差和恢复选项

## 专业判断规则

- 没有依赖和容量依据的日期只能标为目标日期
- 里程碑必须有进入条件、完成证据和责任人
- 缓冲用于吸收不确定性，不得隐藏进度

## 输出契约

返回字段：`milestone`、`entry_criteria`、`exit_evidence`、`owner`、`dependency_type`、`baseline_date`、`forecast_date`、`confidence`。关键结论标记为事实、推断、假设、建议或待决策，并保留来源定位。只生成正式资产候选，不直接覆盖知识、计划、代码、候选人决定或客户承诺。

## 失败与降级

- 来源不可用：返回已完成部分、缺口、影响与安全续跑点。
- 证据冲突：并列冲突和适用条件，不静默裁决。
- 权限不足或出现敏感数据：停止对应读取/动作并请求授权。
- 预算耗尽：保留中间证据、未完成步骤和恢复指针。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要“把WBS转成有依赖逻辑、容量约束、关键路径和缓冲的可预测计划。”，并具备完成“把里程碑定义为决策或验收事件，而非任意日期”与“建立FS/SS/FF依赖网络，记录外部依赖、日历和资源容量”所需的授权材料、环境和范围。
- `do_not_use_when`：无法完成前置检查“把里程碑定义为决策或验收事件，而非任意日期”；执行“建立FS/SS/FF依赖网络，记录外部依赖、日历和资源容量”所需的材料、环境或授权不可用；任务不属于“milestone-plan”职责；或请求违反专属判断规则“没有依赖和容量依据的日期只能标为目标日期”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行milestone-plan，输出milestone、entry_criteria、exit_evidence、owner、dependency_type等字段并保留证据定位。`
- `negative_examples`：`无法完成把里程碑定义为决策或验收事件，而非任意日期，仍请直接执行milestone-plan。`；`缺少执行建立FS/SS/FF依赖网络，记录外部依赖、日历和资源容量所需证据，但请直接定稿milestone、entry_criteria、exit_evidence、owner、dependency_type等字段。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- NSEAP-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)，其中包含任务专属步骤、质量Gate和示例。

## 来源与适配

专业方法适配自 phuryn/pm-skills；CogSeed增加最小Context、证据类型、候选写入、审批和停止规则。具体采用方式、许可证和修改记录见包根目录 `provenance/components.yaml`。
