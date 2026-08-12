---
name: prd-user-stories
description: "把已确认的问题证据、产品目标、用户流程和约束转为可评审PRD、用户故事与可观察验收标准。用于新功能、AI能力或版本范围设计；输入不足时标TBD并提出问题，不虚构用户、技术约束、市场数据或承诺。"
---

# PRD与用户故事

## 目标

建立从问题证据到需求ID、用户故事、验收和Evaluation的可追溯链。

## 开始前

至少确认：

- 问题与证据摘要
- 目标用户、业务目标、范围和非目标
- 技术/合规/时间约束及已知依赖

缺少会改变结论的关键输入时，提出最少必要问题；若用户要求继续，使用 `未知/TBD`，不要补造。

## 工作流

1. 检查问题、用户、为何现在、成功标准和硬约束；缺失关键项时先提最少必要问题。
2. 定义目标、非目标、版本边界、决策人、依赖与假设；不把方案细节提前当成已批准范围。
3. 描述主路径、备选路径、异常路径和权限路径，并为需求分配稳定ID。
4. 按3C组织故事，使用INVEST检查可独立、可协商、有价值、可估算、小而可测；必要时拆分。
5. 为每个故事写4–6条可观察验收标准，覆盖成功、边缘、错误、权限和恢复；避免‘快速/友好/智能’等不可测词。
6. 若包含AI，定义输入/输出边界、工具、数据、拒答、人工确认、质量指标、信任安全和失败降级。
7. 输出需求—证据—故事—验收—Eval追溯表，并列出TBD、开放问题与变更影响。

## 专业判断规则

- 事实、假设、建议和已批准决策必须分层。
- 每个Must需求必须有来源或决策依据。
- PRD不代替技术方案；未知技术选择标TBD。
- 对外承诺、路线图和正式PRD覆盖需人工批准。

## 输出契约

必须返回：

- 结构化PRD
- 用户故事与验收标准
- 需求追溯矩阵
- AI系统要求（适用时）
- TBD/风险/开放问题

所有关键结论都标为 `事实 / 推断 / 假设 / 建议 / 待决策` 之一，并保留证据ID或缺口。只返回正式资产候选，不直接覆盖PRD、路线图或长期认知资产。

## 失败与降级

- 来源不可访问：列出已完成部分、缺失来源和对结论的影响。
- 权限或敏感度不满足：停止对应读取或外部动作，返回所需授权。
- 数据互相冲突：并列冲突及适用条件，不自行裁决为单一事实。
- 预算耗尽：返回当前证据、未完成步骤和可安全续跑点。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要“建立从问题证据到需求ID、用户故事、验收和Evaluation的可追溯链。”，并已提供或授权“问题与证据摘要”与“目标用户、业务目标、范围和非目标”等最小业务输入。
- `do_not_use_when`：缺少或未授权“问题与证据摘要”；“目标用户、业务目标、范围和非目标”的对象、范围或版本无法确认；任务不属于“prd-user-stories”职责；或请求违反专属判断规则“事实、假设、建议和已批准决策必须分层。”。通用安全红线仍适用：不得越权、伪造证据或直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行prd-user-stories，输出结构化PRD并保留证据定位。`
- `negative_examples`：`没有问题与证据摘要，仍请直接完成prd-user-stories。`；`目标用户、业务目标、范围和非目标尚未确认，但请直接定稿结构化PRD。`

本 Skill 是 `EndUseSkill · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。

执行时按需读取以下一层引用：

- 输入/输出和运行边界：[schemas.json](schemas.json)、[references/input-contract.md](references/input-contract.md)、[references/output-contract.md](references/output-contract.md)
- 本体、验证和失败归因：[references/ontology-mapping.md](references/ontology-mapping.md)、[references/validation-contract.md](references/validation-contract.md)、[references/failure-modes.md](references/failure-modes.md)
- 评测、演进和治理：[evals/evals.json](evals/evals.json)、[references/kstar-evolution.md](references/kstar-evolution.md)、[references/governance-boundaries.md](references/governance-boundaries.md)
<!-- NSEAP-GATE:END -->

## 详细方法

执行前读取 [references/method.md](references/method.md)。需要输出模板、质量Gate和示例时，以该文件为准。

## 来源与适配

主体适配自 GitHub Awesome Copilot PRD、phuryn Create PRD 与 User Stories；增加需求ID、CogSeed Context边界和AI非确定性场景。 文件级来源、许可证、SHA和修改记录见包根目录 `provenance/components.yaml` 与 `THIRD_PARTY_NOTICES.md`。
