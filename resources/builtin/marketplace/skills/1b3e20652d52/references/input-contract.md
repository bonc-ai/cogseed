# Input contract — 各字段业务含义

输入三层：`task_id` + `owner_context` + `customer_profile_payload`。
`owner_context` 值由 **Agent 层加载时注入**——本 Skill 从不填 owner_id 或真实授权范围。
画像内容为**脱敏/概要**，不录客户机密数据。

## customer_profile_payload
| 字段 | 含义 | 取值 / 单位 | 来源 |
|---|---|---|---|
| `customer_name` | 客户名或脱敏占位 | string（可留空，如"某能源集团"） | 售前录入（脱敏） |
| `industry` | 行业，决定本体/主案例/场景货架 | 能源/煤炭/电网/石油天然气/制造/电信/政务/其他 | 售前录入 |
| `audience_level` | 听众层级，决定版本 + 话术档 | P1_一把手 / P2_执行层信息化 / P3_技术验证纪检 | 售前研判 |
| `relationship_trust` | 关系信任档，决定信息颗粒度 | A_直接可靠 / B_渠道二道贩子 / C_竞对未确认 | 售前研判 |
| `meeting_format` | 交流形式，决定时长裁剪 | 高层15分 / 中层30分 / Demo45分 | 会议安排 |
| `compliance_sensitive` | 是否合规敏感 → 走"可解释·可倒查"词系 | 0/1 | 售前研判 |
| `pain_trigger` | 痛点触发器 → 开场钩子 | 效率痛 / 效果痛_二次购买 / 认知断层痛 | 售前研判 |
| `known_impression` | 预设印象/敏感点 → 预置异议 | string[]（"又一个AI项目""怕泄露""关注取数减人"） | 售前情报 |
| `existing_systems` | 已有系统 → 现状页填充 | string[]（MES/SCADA/ERP/招采/数据中台…） | 客户调研 |
| `priority_scenarios` | 客户关心场景 | string[]（招投标合规/政策/财务审计…） | 客户调研 |
| `decision_chain_note` | 决策链/关系可控性（信任边界研判） | string | 售前研判 |

## owner_context（仅字段位；值由 Agent 层注入）
| 字段 | 含义 |
|---|---|
| `owner_id` | 谁拥有这次售前准备动作（注入） |
| `role` | 属主角色，用于策略/权限（注入） |
| `authorization_scope` | 该属主被允许做什么（注入） |

> Skill 声明**需要什么**；它不解析身份、不直连《销售 QA 库》/冻结表等资源——那是 Agent/Gateway 层的活。
