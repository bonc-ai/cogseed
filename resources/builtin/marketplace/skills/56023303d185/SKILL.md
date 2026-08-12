---
name: AI产品阶段编排
description: 识别入口模式、当前阶段与首要不确定性，路由到七个阶段 Skill，停在人工 Gate。
---

# AI 产品方法总编排

本 Skill 是“个人 AI 产品方法”1+7 套件的本地 candidate。它只处理
`Orchestrate` 范围，并把输出绑定到稳定 ID、产品版本与来源引用。

`use_when`:
- 启动一个 0→1 AI 产品
- 处理已冻结产品的实质迭代
- 诊断线上问题并选择正确阶段
- 判断下一道必须由人作出的 Gate

`do_not_use_when`:
- 代替 owner 批准 Gate、staged 或发布
- 绕过阶段直接构建或上线
- 把未知证据、日期或业务结果补写为事实

`positive_examples`: 在当前阶段整理事实、形成可验证产物并请求下一道 Gate。

`negative_examples`: 跳过 Gate；伪造 Evidence 或日期；代替 owner 决定；全局安装；
外发；发布；生产写入。

## Trigger Semantics

必须读取当前入口模式、产品版本、现有 Gate 和 Evidence。阶段不匹配时路由而不是
勉强执行；上下文歧义时询问。任何 owner decision 缺失、摘要漂移或保护面风险都
返回 `blocked` 或 `returned`。

## Business Context Mapping

TBox：ProductVersion, Stage, Uncertainty, Gate, ChangeCandidate。
RBox：routes_to, blocked_by, governed_by, supported_by。
ABox 仅使用标明来源类型的项目事实或 synthetic 示例；示例不得冒充用户证据。

## Executable Workflow

1. 读取 `.ai-product/` 中的当前版本、Gate、Handoff、Evidence 和 Change Candidate；摘要不得覆盖原始事实。
2. 先区分 `zero_to_one`、`iteration`、`diagnosis` 三种入口；冻结后实质变化必须先进入 Change Candidate。
3. 从价值、体验、AI 能力、集成、治理五类中选择一个首要不确定性；证据不足时保持未知。
4. 映射到 Frame、Discover、Qualify、Define、De-risk、Build & Evaluate 或 Launch & Learn；不得跳过前置 Gate。
5. 输出唯一下一动作、所需人工 Gate 和禁止动作；owner 决定缺失时停止。

阶段稳定输出：current_stage、primary_uncertainty、selected_skill、next_action、approval_gate。输出同时包含事实/假设区分、Evidence/Decision 引用、
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

本阶段退出门为 `next_required_human_gate`，只能由规定的人类角色决定。
自动化上限为 `staged_eligible`，当前包状态仅为 `candidate`。
不允许宣称 Level B、release ready、production ready、published、客户价值或 Level C。

递归护栏：对 Meta Skill 自身最多提出 1 个 patch、深度 1；只允许修改配置、阈值权重和策略开关。正式规则、HITL、审计、权限与发布边界为保护面。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：识别入口模式、当前阶段与首要不确定性，路由到七个阶段 Skill，停在人工 Gate。，并具备完成该任务所需的授权材料、环境和范围。
- `do_not_use_when`：所需材料、环境或授权不可用；任务不属于「AI产品阶段编排」职责；或请求违反专属判断规则。通用安全红线仍适用：不得越权、不得伪造证据、不得直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行AI产品阶段编排，输出结构化的可审计结果并保留证据定位。`
- `negative_examples`：`缺少执行AI产品阶段编排所需证据，仍请直接定稿。`

本 Skill 是共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- NSEAP-GATE:END -->
