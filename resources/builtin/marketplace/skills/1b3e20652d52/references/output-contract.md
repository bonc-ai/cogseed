# Output contract — customer-profile-presales

输出形态：`actions` / `result` / `trace` / `audit_refs`（`audit_refs` 硬性必填，由 runtime append-only 发出）。
`result` 内含 `session_plan`（一期，子能力①-④）与 `customized_deck`（二期，子能力⑤）。

## result.session_plan（作战方案）
| 字段 | 类型 | 说明 |
|---|---|---|
| `deck_version` | enum | 高层版 / 中层版 / Demo版（由 R1 路由） |
| `granularity` | `{level: A/B/C, forbidden: string[]}` | 信息颗粒度 + 本场禁讲项（由 R2 路由） |
| `talk_track` | enum | 战略叙事 / 战术落地 |
| `hook` | `{type, text}` | 30 秒钩子（选定文案） |
| `scenarios` | `[{name, priority, promise_grade, acceptance_metric}]` | 场景清单（承诺分级 A-/B + 验收指标口径） |
| `differentiation` | string | 护城河轴（vs 自研/通用/决策智能） |
| `objection_cards` | `[{q, one_liner, qa_id}]` | 异议应答（来自《销售 QA 库》Q1–Q8） |
| `redlines` | `{promise_ceiling, register_downgrade[], no_name_competitor, sample_data_label}` | 本场红线 |
| `material_list` | string[] | 材料/产出物清单 |

## result.customized_deck（定制出稿，二期，子能力⑤）
| 字段 | 类型 | 说明 |
|---|---|---|
| `slot_fills` | `[{page, slot, value}]` | 槽位填充映射（客户名/行业场景/案例/Step） |
| `checks` | `{caliber, register, promise, traceability: bool, issues: string[]}` | 三道护栏校验结果 |
| `visual_profile` | enum | 套用的定稿样式（官网深空金/…） |
| `status` | enum | **恒 `pending_human_review`**（不自动定稿） |
| `deck_file` | string | 待确认定制稿（文件占位） |

## trace / audit_refs
- `trace`：触发了哪些规则（R1a/R2b/R3…）、选了哪版、删了哪些禁讲项、取了哪几条 QA——可回溯的推理链。
- `audit_refs`：runtime 发出的 append-only 审计引用；本 Skill 只声明字段位，不自行写审计。

> `session_plan` 是一期核心产出；`customized_deck` 的 `status` 恒为"待人工终审"，符号层校验三道护栏后仍需人签字，绝不自动定稿。
