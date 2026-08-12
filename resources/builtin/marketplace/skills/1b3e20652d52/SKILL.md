---
name: 客户画像售前
description: 根据客户画像（谁、行业、层级、关系、痛）产出定制售前打法：模板选型、30 秒开场、场景清单、差异化、异议应答与信息颗粒度、承诺分级；输出暂存级作战草案，对客定稿由人确认。
---

# 客户画像售前赋能 · Customer-Profile Pre-sales Enablement

给一个客户画像（谁、哪个行业、什么层级、什么关系、什么痛），产出一套"这一场怎么打"的定制售前打法：
用哪版模板、开场 30 秒讲什么、聊哪几个场景、怎么做差异化、预置哪些异议应答，以及本场的信息颗粒度、
承诺分级与语域红线。把"打动客户"从少数人的临场发挥，变成每个一线售前都能稳定打出的组织能力。

Staged-capped：本 Skill 产出的是**作战草案 / 待确认定制稿**，对客最终稿永远由人签字确认——定稿、发送、
上场都是下游动作，本 Skill 从不执行。

## Product-system placement（Step 0）

**EndUseSkill · Skill-L5 · Asset-L2 · master_task_skill（owns_session: true）· interpreted**

- **用途二分**：EndUseSkill——业务产出（一线售前的作战方案与定制材料），不是造技能的生产过程技能。
- **session_role**：`master_task_skill`——它是"备一场售前交流"这个会话的入口与主技能；One-Session → One-Master → Many-Sub。
- **五个 sub_skill**（本 Master 编排、各自独立适用本标准）：① 画像分析 ② 定制作战方案生成 ③ 异议应答（喂《销售 QA 库》）④ 画像模拟练兵 ⑤ 定制出稿（修改/生成 PPT，二期）。
- **K = 本体 + 技能**：携带自身本体切片 K_skill（CustomerProfile 实体 + 路由规则），见 `references/ontology-mapping.md`。
- **Position**：Skill Layer 制品，供上层任务智能体运行时（E0）消费；只暴露契约字段位，真实本体权威/运行时/属主绑定/发布由其他层负责。

## Trigger semantics
- **use_when**: 售前/商务在为某个具体客户交流做准备，需要"这一场怎么打"的定制打法（选版本、钩子、场景、差异化、异议、红线）。
- **do_not_use_when**: 通用产品答疑、报价、或撰写冻结口径本身——那是治理，不是按场次的作战方案；也不用于对客直接发送/定稿（那是人签字的下游动作）。
- **positive_examples**: ["下周见某电网信息公司一把手，15 分钟，帮我准备这一场", "客户觉得我们是又一个 AI 项目，开场该讲什么、预置哪些异议"]
- **negative_examples**: ["这个功能多少钱", "把 slogan 改一版对外发布", "直接把这版 deck 发给客户"]

## Business context（ontology slice → references/ontology-mapping.md）
- **TBox**: `CustomerProfile{industry, audience_level, relationship_trust, meeting_format, compliance_sensitive, pain_trigger}`
- **RBox**: R1 层级→版本/话术；R2 关系档→信息颗粒度 A/B/C（含禁讲项）；R3 合规敏感→语域降级"可解释·可倒查"；R4 承诺分级——B 在建场景不得写进 Step1/验收承诺（HITL）；R5 对客不点名友商（恒约束）；R6 未定价不报硬数字（O16）；R7 槽位按选定版本过滤（本版没有的槽位如高层版无本体页→降讲解备注或流转有该页的版本）。
- **ABox**: 授权期为空（画像实例运行时注入，且为脱敏/概要，不录客户机密）。

## Workflow
`start → profile_intake → classify(选版本/定颗粒度/选话术) → assemble(钩子/场景/差异化/异议/红线) → preview(SessionPlan) → confirm(HITL·人工终审) → generate(CustomizedDeck 草案) → close`

HITL gate 在 `confirm`：任何"定制出稿/定稿"动作前必须人工终审；`CustomizedDeck.status` 恒为 `pending_human_review`，不自动定稿。R4/R5/R6 触及承诺、友商、价格时强制人工复核。

## Input / output
见 `references/schemas.json`——三层输入（`task_id` + `owner_context` + `customer_profile_payload`），
输出 `actions/result/trace/audit_refs`，`result` 内含 `session_plan` 与（二期）`customized_deck`。
字段业务含义见 `references/input-contract.md`，输出形态见 `references/output-contract.md`。

## Governance & non-claims（references/governance-boundaries.md）
- `promotion_ceiling: staged` · `production_release_allowed: false`——每件制品皆 staged。
- 本 Skill **分析 + 起草**；不定稿、不发送、不上场，不碰真实客户机密数据。属主/资源值由 Agent 层注入（`binding_resolved_by: agent_layer`），不持令牌、不直连资源。
- **口径受治理**：所有输出以冻结表为唯一口径源，触及口径变更走回流纪律；符号层裁决对错（选哪版/哪档颗粒度/合不合规），神经层只起草措辞与候选，绝不写 `formal`/`config_key`/`value`。
- 不宣称：生产就绪、已投产、已在真实业务中"学会"、或可被生产运行时直接加载。这是一个 staged、合标准的脚手架。

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：根据客户画像（谁、行业、层级、关系、痛）产出定制售前打法：模板选型、30 秒开场、场景清单、差异化、异议应答与信息颗粒度、承诺分级；输出暂存级作战草案，对客定稿由人确认。，并具备完成该任务所需的授权材料、环境和范围。
- `do_not_use_when`：所需材料、环境或授权不可用；任务不属于「客户画像售前」职责；或请求违反专属判断规则。通用安全红线仍适用：不得越权、不得伪造证据、不得直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行客户画像售前，输出结构化的可审计结果并保留证据定位。`
- `negative_examples`：`缺少执行客户画像售前所需证据，仍请直接定稿。`

本 Skill 是共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- NSEAP-GATE:END -->
