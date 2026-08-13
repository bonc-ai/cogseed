---
name: risk-dependency
description: "建立带触发器、责任人、缓解与应急方案的RAID账本并按阈值升级。 用于项目经理的专业任务；当关键证据缺失、需要越权或涉及正式写入时停止并请求确认。"
---

# 风险与依赖管理

## 目标

建立带触发器、责任人、缓解与应急方案的RAID账本并按阈值升级。

## 开始前

确认任务目标、授权来源、版本、输出用途和成功标准。会改变结论的关键输入缺失时提出最少必要问题；若继续，使用 `未知/TBD`，不得补造。

## 工作流

1. 从计划、接口、资源、供应商和假设中识别风险/问题/依赖/决策
2. 用概率、影响、紧迫性和可检测性评分并写清证据
3. 为每项指定owner、触发器、缓解、应急和下次复核时间
4. 按阈值升级；关闭时保存结果与剩余风险

## 专业判断规则

- 风险写未来不确定事件，问题写已发生事实
- 缓解降低概率或影响，应急在触发后执行
- 依赖必须记录提供方、需要时间和失约影响

## 输出契约

返回字段：`raid_id`、`type`、`cause_event_impact`、`probability`、`impact`、`trigger`、`owner`、`mitigation`、`contingency`、`due`。关键结论标记为事实、推断、假设、建议或待决策，并保留来源定位。只生成正式资产候选，不直接覆盖知识、计划、代码、候选人决定或客户承诺。

## 失败与降级

- 来源不可用：返回已完成部分、缺口、影响与安全续跑点。
- 证据冲突：并列冲突和适用条件，不静默裁决。
- 权限不足或出现敏感数据：停止对应读取/动作并请求授权。
- 预算耗尽：保留中间证据、未完成步骤和恢复指针。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要“建立带触发器、责任人、缓解与应急方案的RAID账本并按阈值升级。”，并具备完成“从计划、接口、资源、供应商和假设中识别风险/问题/依赖/决策”与“用概率、影响、紧迫性和可检测性评分并写清证据”所需的授权材料、环境和范围。
- `do_not_use_when`：无法完成前置检查“从计划、接口、资源、供应商和假设中识别风险/问题/依赖/决策”；执行“用概率、影响、紧迫性和可检测性评分并写清证据”所需的材料、环境或授权不可用；任务不属于“risk-dependency”职责；或请求违反专属判断规则“风险写未来不确定事件，问题写已发生事实”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行risk-dependency，输出raid_id、type、cause_event_impact、probability、impact等字段并保留证据定位。`
- `negative_examples`：`无法完成从计划、接口、资源、供应商和假设中识别风险/问题/依赖/决策，仍请直接执行risk-dependency。`；`缺少执行用概率、影响、紧迫性和可检测性评分并写清证据所需证据，但请直接定稿raid_id、type、cause_event_impact、probability、impact等字段。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- NSEAP-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)，其中包含任务专属步骤、质量Gate和示例。

## 来源与适配

专业方法适配自 msitarzewski/agency-agents；CogSeed增加最小Context、证据类型、候选写入、审批和停止规则。具体采用方式、许可证和修改记录见包根目录 `provenance/components.yaml`。
