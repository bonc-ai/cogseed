---
name: AI产品立项聚焦
description: 把想法框定为明确的用户、场景、结果、边界和待验证问题，停在人工 Gate。
---

# Frame｜产品机会框定

本 Skill 是“个人 AI 产品方法”1+7 套件的本地 candidate。它只处理
`Frame` 范围，并把输出绑定到稳定 ID、产品版本与来源引用。

`use_when`:
- 新产品方向尚未形成问题定义
- 现有方向需要重新确认目标用户与结果

`do_not_use_when`:
- 已有冻结 Frame 且没有新证据或实质变化
- 直接要求设计页面或写代码

`positive_examples`: 在当前阶段整理事实、形成可验证产物并请求下一道 Gate。

`negative_examples`: 跳过 Gate；伪造 Evidence 或日期；代替 owner 决定；全局安装；
外发；发布；生产写入。

## Trigger Semantics

必须读取当前入口模式、产品版本、现有 Gate 和 Evidence。阶段不匹配时路由而不是
勉强执行；上下文歧义时询问。任何 owner decision 缺失、摘要漂移或保护面风险都
返回 `blocked` 或 `returned`。

## Business Context Mapping

TBox：User, Workflow, Problem, Outcome, Constraint。
RBox：experiences, seeks, constrained_by, measured_by。
ABox 仅使用标明来源类型的项目事实或 synthetic 示例；示例不得冒充用户证据。

## Executable Workflow

1. 区分已知事实、利益相关者观点、假设和未知项；不给 E0 想法伪造证据等级。
2. 描述目标用户当前工作流、触发事件、代价和现有替代方案。
3. 形成可证伪的问题陈述、目标结果与明确非目标。
4. 列出最小证据缺口和下一次用户接触，不抢先决定产品形态。
5. 生成 Frame Gate 请求；缺少 owner 决定时保持 proposed。

阶段稳定输出：problem_statement、target_outcome、non_goals、open_questions。输出同时包含事实/假设区分、Evidence/Decision 引用、
唯一下一动作、所需 Gate、允许与禁止宣称。

## Tool Resource Binding

允许：读取获准项目文件、草拟项目内产物、运行本地校验、输出 Change Candidate。
默认禁止：网络外发、生产写入、权限提升、全局 Skill 安装、发布和代填人工决定。
工具不可用时明确 `blocked`，不得回退为种子数据、旧快照或无来源猜测。

## Validation Contract

输入输出必须通过本包 JSON Schema；包根 16 个 NSEAP 资产和 4 个机器增强资产
必须完整。状态、摘要、artifact refs、approval required、claims allowed/prohibited
为必填。保护面失败容忍度为 0，未知失败保持 `pending`。

## Eval Replay Regression Contract

本包包含 10 条独立 EvalCase，其中 4 条负例，并覆盖 trigger、anti-trigger、
boundary、failure、prohibited_behavior。运行时或模型变化、流程/Gate/权限/
schema 变化必须重跑本包用例和冻结的 12 条套件 E2E。

## Failure Attribution

失败只能归因到 product、model、prompt、data、tool、permission、workflow、
schema、governance、evidence。证据不足不得强行归因；unknown 必须进入待分类。

## KSTAR Evolution Hook

记录 Situation、Task、predicted Action/Result、actual Action/Result、ΔA、ΔR。
学习只产生 Change Candidate；不得把 ΔR 直接写入运行中 Skill。

## Governance Boundaries

本阶段退出门为 `Frame Gate`，只能由规定的人类角色决定。
自动化上限为 `staged_eligible`，当前包状态仅为 `candidate`。
不允许宣称 Level B、release ready、production ready、published、客户价值或 Level C。

稳定输出必须能被 Discover 直接引用，并保留所有 source refs。
