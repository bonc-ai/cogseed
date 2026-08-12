---
name: feedback-summary
description: "合并独立面试反馈，保留分歧、量表和证据缺口，供人工决策。 用于招聘专员的专业任务；当关键证据缺失、需要越权或涉及正式写入时停止并请求确认。"
---

# 评估证据汇总

## 目标

合并独立面试反馈，保留分歧、量表和证据缺口，供人工决策。

## 开始前

确认任务目标、授权来源、版本、输出用途和成功标准。会改变结论的关键输入缺失时提出最少必要问题；若继续，使用 `未知/TBD`，不得补造。

## 工作流

1. 冻结提交后再合并独立反馈，避免先入意见污染
2. 把每条评价拆成观察事实、解释、评分和定位证据
3. 归一化量表但保留原始值，标出冲突与未覆盖标准
4. 输出岗位相关证据、风险、补证建议和人工决定点

## 专业判断规则

- “感觉好/不好”没有行为证据时不得计分
- 分歧要显示，不能平均掉
- 系统只生成建议与审计记录，不作最终录用决定

## 输出契约

返回字段：`interviewer_ref`、`criterion_id`、`observation`、`interpretation`、`rating`、`conflict`、`gap`、`human_decision`。关键结论标记为事实、推断、假设、建议或待决策，并保留来源定位。只生成正式资产候选，不直接覆盖知识、计划、代码、候选人决定或客户承诺。

## 失败与降级

- 来源不可用：返回已完成部分、缺口、影响与安全续跑点。
- 证据冲突：并列冲突和适用条件，不静默裁决。
- 权限不足或出现敏感数据：停止对应读取/动作并请求授权。
- 预算耗尽：保留中间证据、未完成步骤和恢复指针。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要“合并独立面试反馈，保留分歧、量表和证据缺口，供人工决策。”，并具备完成“冻结提交后再合并独立反馈，避免先入意见污染”与“把每条评价拆成观察事实、解释、评分和定位证据”所需的授权材料、环境和范围。
- `do_not_use_when`：无法完成前置检查“冻结提交后再合并独立反馈，避免先入意见污染”；执行“把每条评价拆成观察事实、解释、评分和定位证据”所需的材料、环境或授权不可用；任务不属于“feedback-summary”职责；或请求违反专属判断规则““感觉好/不好”没有行为证据时不得计分”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行feedback-summary，输出interviewer_ref、criterion_id、observation、interpretation、rating等字段并保留证据定位。`
- `negative_examples`：`无法完成冻结提交后再合并独立反馈，避免先入意见污染，仍请直接执行feedback-summary。`；`缺少执行把每条评价拆成观察事实、解释、评分和定位证据所需证据，但请直接定稿interviewer_ref、criterion_id、observation、interpretation、rating等字段。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- NSEAP-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)，其中包含任务专属步骤、质量Gate和示例。

## 来源与适配

专业方法适配自 interviewstreet/hiring-agent；CogSeed增加最小Context、证据类型、候选写入、审批和停止规则。具体采用方式、许可证和修改记录见包根目录 `provenance/components.yaml`。
