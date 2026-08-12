# Ontology slice — customer-profile-presales

技能的世界模型 K_skill：客户画像的概念/字段（TBox）、路由与红线规则（RBox）、实例（ABox）。
规则为**结构化**（field/op/value + action），下游读数据、不解析人读的 `formal` 串。

## TBox（概念 + 字段）
- `CustomerProfile`: `industry`, `audience_level`, `relationship_trust`, `meeting_format`, `compliance_sensitive`, `pain_trigger`, `known_impression`, `existing_systems`, `priority_scenarios`, `decision_chain_note`
- `SessionPlan`: `deck_version`, `granularity`, `talk_track`, `hook`, `scenarios`, `differentiation`, `objection_cards`, `redlines`, `material_list`
- `CustomizedDeck`: `slot_fills`, `checks`, `visual_profile`, `status`, `deck_file`

## RBox（规则 — 结构化；`formal` 仅供人读，永不机器解析）
| rule_id | formal | field | op | value | action |
|---|---|---|---|---|---|
| R1a | 一把手 → 高层版 + 战略叙事 | audience_level | eq | P1_一把手 | route_deck_gaoceng |
| R1b | 执行层信息化 → 中层版 + 战术落地 | audience_level | eq | P2_执行层信息化 | route_deck_zhongceng |
| R1c | 技术验证纪检 → Demo 版 + 证据线 | audience_level | eq | P3_技术验证纪检 | route_deck_demo |
| R2a | 关系 A 直接可靠 → 信息颗粒度 A | relationship_trust | eq | A_直接可靠 | granularity_A |
| R2b | 关系 B 渠道/二道贩子 → 颗粒度 B，删方法论细节/价格/客户名单 | relationship_trust | eq | B_渠道二道贩子 | granularity_B |
| R2c | 关系 C 有竞对/未确认 → 颗粒度 C，最严禁讲面 | relationship_trust | eq | C_竞对未确认 | granularity_C |
| R3 | 合规敏感 → 语域降级"可解释·可倒查"，禁"自进化/自升级" | compliance_sensitive | eq | 1 | register_downgrade_explainable |
| R4 | 承诺分级：B 在建场景不得写进 Step1/验收承诺（需 HITL） | scenario_promise_grade | eq | B_在建 | hitl_promise_review |
| R5 | 对客不点名友商（正式材料恒约束） | no_name_competitor | eq | 1 | null |
| R6 | 未定价（O16）不报硬数字/区间 | pricing_locked_O16 | eq | 1 | null |
| R7 | 槽位按选定版本过滤：只输出该版本存在的槽位；本版没有的槽位（如高层版无本体页）→ 降为讲解备注或流转有该页的版本 | deck_version | filter | slot_map[deck_version] | gate_slots_by_version |

### R7 · 版本 × 槽位闸（seam 焊死）
`SessionPlan.material_list` / `CustomizedDeck.slot_fills` **必须先过 R7**：拿 `deck_version` 去查该版本的槽位地图，只保留本版真实存在的占位；本版没有的判定（典型：**行业本体选型** = 中层版 p10 / 母版 06 的槽位，**高层版无本体页**）不得作为高层版槽位输出，而是：① 落到 `talk_track` 讲解备注（如"讲解时点一句电网用 IEC CIM"），或 ② 标记 `defer_to_version: 中层版`，随后续技术交流版落地。
版本→可填槽位（权威见《高层版/中层版槽位地图》）：
- **高层版**：p1 封面 · p2 项目名 · p6 行业实例 · p7/p8 主场景 · p9 实证数字 · p12 路线图；讲解选项 p2 锚定加压 / p5 exhibit 变体。（**无本体页**）
- **中层版**：高层同款 + **p3 现状** · **p10 本体（ISA-95/CIM…）** · **p17 资质台账**。
- **Demo 版**：客户名 · POC 四标准打分 · Step1 工作坊。

`route_*` / `granularity_*` / `register_downgrade_*` / `gate_slots_by_version` 是**可学习策略**（默认按上表）；KSTAR 环可依 ΔR
微调映射阈值（如"某行业 P2 其实要走高层版"），但只在 staged 候选层，且改配置不改规则结构。R4/R5/R6 是
**保护面不变量**——永不可被补丁修改（形式化规则结构、HITL 要求、审计机制）。

## ABox
授权期为空（画像实例运行时注入）。注入的画像为脱敏/概要，不含客户机密（见 input-contract）。

## Traceability（source_refs）
- `materials::customer-profile-presales::snapshot`
- `冻结表`（唯一口径源：slogan/语域/承诺分级/案例红线）
- `D18 售前模板体系`（高层/中层/Demo 三版）
- `销售QA异议应答库 v0.4`（Q1–Q8）

平台本体注册表绑定为**目标态**（待 schema 权威决策）；当前以本地 snapshot ref 为诚实字段位。
