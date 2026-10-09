---
name: AI产品构建评测
description: 从冻结 Spec 执行受控开发，以评测、回滚和追溯证明实现符合规格，停在人工 Gate。
---

# Build & Evaluate｜受控实现与评测

本 Skill 是“个人 AI 产品方法”1+7 套件的本地 candidate。它只处理
`Build & Evaluate` 范围，并把输出绑定到稳定 ID、产品版本与来源引用。

`use_when`:
- Discovery Gate 已通过且 Spec/plan/tasks 已冻结
- 需要实现、测试或诊断规格偏差

`do_not_use_when`:
- 产品结论仍在变化
- 没有 Eval 合同就先构建
- 把测试通过当成发布批准

`positive_examples`: 在当前阶段整理事实、形成可验证产物并请求下一道 Gate。

`negative_examples`: 跳过 Gate；伪造 Evidence 或日期；代替 owner 决定；全局安装；
外发；发布；生产写入。

## Trigger Semantics

必须读取当前入口模式、产品版本、现有 Gate 和 Evidence。阶段不匹配时路由而不是
勉强执行；上下文歧义时询问。任何 owner decision 缺失、摘要漂移或保护面风险都
返回 `blocked` 或 `returned`。

## Business Context Mapping

TBox：Specification, Task, Implementation, EvaluationRun, RollbackPlan。
RBox：implements, verified_by, traces_to, restored_by。
ABox 仅使用标明来源类型的项目事实或 synthetic 示例；示例不得冒充用户证据。

## Executable Workflow

1. 校验 Spec、plan、tasks、产品版本和 Gate 摘要一致；漂移先创建 Change Candidate。
2. 遵循测试先行和依赖顺序，只执行获准的本地可逆工作。
3. 运行单元、契约、负向、E2E 和保护面评测；blocked/error 不计通过。
4. 保存 runtime/model/config、输入输出摘要、失败归因、回滚点和完整 trace。
5. 汇总 Release Readiness Gate 材料；工具不能批准发布或 staged。

阶段稳定输出：implementation_status、evaluation_results、rollback_evidence、readiness_gaps。输出同时包含事实/假设区分、Evidence/Decision 引用、
唯一下一动作、所需 Gate、允许与禁止宣称。

## Tool Resource Binding

允许：读取获准项目文件、草拟项目内产物、运行本地校验、输出 Change Candidate。
默认禁止：网络外发、生产写入、权限提升、全局 Skill 安装、发布和代填人工决定。
工具不可用时明确 `blocked`，不得回退为种子数据、旧快照或无来源猜测。

## Validation Contract

输入输出必须通过本包 JSON Schema；包根 16 个标准资产和 4 个机器增强资产
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

本阶段退出门为 `Release Readiness Gate`，只能由规定的人类角色决定。
自动化上限为 `staged_eligible`，当前包状态仅为 `candidate`。
不允许宣称 Level B、release ready、production ready、published、客户价值或 Level C。

任何写生产、外发、权限提升或全局安装都超出本 Skill 权限。

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：从冻结 Spec 执行受控开发，以评测、回滚和追溯证明实现符合规格，停在人工 Gate。，并具备完成该任务所需的授权材料、环境和范围。
- `do_not_use_when`：所需材料、环境或授权不可用；任务不属于「AI产品构建评测」职责；或请求违反专属判断规则。通用安全红线仍适用：不得越权、不得伪造证据、不得直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行AI产品构建评测，输出结构化的可审计结果并保留证据定位。`
- `negative_examples`：`缺少执行AI产品构建评测所需证据，仍请直接定稿。`

本 Skill 是共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- SKILL-GATE:END -->
