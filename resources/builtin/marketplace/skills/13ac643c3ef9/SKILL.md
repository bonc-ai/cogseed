---
name: source-extraction
description: "从代码、规范和现有文档中建立带版本、定位与冲突状态的事实账本。 用于技术写作／知识管理的专业任务；当关键证据缺失、需要越权或涉及正式写入时停止并请求确认。"
---

# 来源证据抽取

## 目标

从代码、规范和现有文档中建立带版本、定位与冲突状态的事实账本。

## 开始前

确认任务目标、授权来源、版本、输出用途和成功标准。会改变结论的关键输入缺失时提出最少必要问题；若继续，使用 `未知/TBD`，不得补造。

## 工作流

1. 冻结来源清单、版本、优先级和访问范围
2. 抽取声明、约束、示例及精确定位，区分事实/主张/推断
3. 交叉验证接口、默认值与示例；执行或标明未执行代码
4. 并列冲突、过期来源和未知项，指定待确认owner

## 专业判断规则

- 运行中代码/正式规范优先级高于未版本化说明
- 未经执行的示例不得标为已验证
- 来源冲突不自行合并为单一事实

## 输出契约

返回字段：`claim_id`、`claim`、`source`、`version`、`locator`、`type`、`verification`、`conflict`。关键结论标记为事实、推断、假设、建议或待决策，并保留来源定位。只生成正式资产候选，不直接覆盖知识、计划、代码、候选人决定或客户承诺。

## 失败与降级

- 来源不可用：返回已完成部分、缺口、影响与安全续跑点。
- 证据冲突：并列冲突和适用条件，不静默裁决。
- 权限不足或出现敏感数据：停止对应读取/动作并请求授权。
- 预算耗尽：保留中间证据、未完成步骤和恢复指针。

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：需要“从代码、规范和现有文档中建立带版本、定位与冲突状态的事实账本。”，并具备完成“冻结来源清单、版本、优先级和访问范围”与“抽取声明、约束、示例及精确定位，区分事实/主张/推断”所需的授权材料、环境和范围。
- `do_not_use_when`：无法完成前置检查“冻结来源清单、版本、优先级和访问范围”；执行“抽取声明、约束、示例及精确定位，区分事实/主张/推断”所需的材料、环境或授权不可用；任务不属于“source-extraction”职责；或请求违反专属判断规则“运行中代码/正式规范优先级高于未版本化说明”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行source-extraction，输出claim_id、claim、source、version、locator等字段并保留证据定位。`
- `negative_examples`：`无法完成冻结来源清单、版本、优先级和访问范围，仍请直接执行source-extraction。`；`缺少执行抽取声明、约束、示例及精确定位，区分事实/主张/推断所需证据，但请直接定稿claim_id、claim、source、version、locator等字段。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- SKILL-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)，其中包含任务专属步骤、质量Gate和示例。

## 来源与适配

专业方法适配自 wshobson/agents；CogSeed增加最小Context、证据类型、候选写入、审批和停止规则。具体采用方式、许可证和修改记录见包根目录 `provenance/components.yaml`。
