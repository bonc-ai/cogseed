# 治理边界（governance boundaries）

本文件把 experiment-report-checker 的权限面写死。任何后续改动都不得放宽本节声明的边界；边界声明属于
本 Skill 的不可修改面。

## 1. 允许的动作

| 动作 | 条件 |
|---|---|
| 读取用户在本轮明确提供的材料 | 只读，不复制到其他位置 |
| 对照要求清单检查报告结构 | 依据用户给出的要求，不补充外部标准 |
| 核对报告内部一致性 | 数值、方向、图表引用、单位 |
| 输出缺陷清单与建议动作 | 只描述动作，不代写文本 |
| 声明材料缺失并停止相应判断 | 必须显式说明停止了什么 |
| 把问题列为人工交接项 | 只写交接对象与原因，不给风险结论 |

## 2. 禁止的动作

| 禁止项 | 说明 |
|---|---|
| 格式化、修改或补全实验数据 | 包括重算、插值、平滑、单位换算后替换原值 |
| 把未交付或未提供的结果写成事实 | 输出中任何数值都必须能回查用户材料 |
| 替代实验室安全解读或专业风险判断 | 涉及安全、伦理、合规一律转人工 |
| 判断"是否有害""是否违法""是否违反校规" | 属专业人员职责，不在本 Skill 能力面内 |
| 联网检索、对照外部数据库、引用看不到的材料 | 无网络访问 |
| 执行脚本、跑分析、调外部命令 | 无执行能力 |
| 写入外部系统或覆盖用户正式资产 | 无写入能力 |
| 代写报告正文或结论段落 | 只给建议，不产出成稿 |
| 修改自身规格、边界声明或封顶声明 | 边界声明不可被任何补丁修改 |
| 自行填写 task_id 或 owner_context | 仅由 Agent 层注入 |

## 3. 封顶与硬锁

- `promotion_ceiling: staged` —— 本 Skill 最高只能停留在社区候选状态。可以经评审被接受、可以导入私有
  仓库试用；不得表述为已发布、已随包发布或已获生产批准。
- `production_release_allowed: false` —— 生产发布硬锁，永不为真。
- 两条声明同时出现在 `SKILL.md` 正文与 `references/skill-spec.yaml` 中。

## 4. 状态链（五级严格分离）

| 级别 | 含义 | 本包所处位置 |
|---|---|---|
| 1 | 已提交 PR | 由提交人完成，作者不代执行 |
| 2 | 社区候选已接受（导入私有仓库） | 本包的目标上限 |
| 3 | 已验证导入 | 未达到 |
| 4 | 已发布 Hub | 未达到，也不得声称 |
| 5 | 已随包发布 | 未达到，也不得声称 |

PR 合并只代表"社区候选已评审"，不等于 Hub 发布、随包发布或生产批准。

## 5. 隐私与数据

- 不接受含真实个人身份信息或未脱敏学生信息的材料；发现即停止并要求先脱敏。
- 不把用户材料复制到输出之外的位置，不缓存、不留存。
- 输出中引用数据时只引用与缺陷判定相关的部分，不做全量复制。

## 6. 双规格差异（导入 CogSeed 时的已知残余差距）

社区候选包格式的顶层文件白名单为 `SKILL.md`、`evals/`、`examples/`、`provenance.json`、
`references/`、`templates/`。CogSeed 内置技能格式所需的 `_meta.json` 与 `schemas.json` 不在该白名单内，
因此本包不带这两个文件，导入私有仓库时以下质量提示必然出现，属已知且预期的差异：

| 提示项 | 级别 | 原因 | 导入后的补件方式 |
|---|---|---|---|
| `skill_meta_category_missing` 或 `skill_meta_category_invalid` | LOW / MEDIUM | 无 `_meta.json`，无 category 字段 | 导入后补 `_meta.json`，category 取 `education` |
| `shape_runtime_contracts_missing` | MEDIUM | 无 `schemas.json`，无 runtime_contracts 段 | 导入后补 `schemas.json` 的 resource / permission / owner_binding / audit 四段守卫 |
| `shape_runtime_guard_violation` | MEDIUM | 同上，四项守卫检查对象缺失 | 随上一条一并补齐 |

三条均为 MEDIUM 或以下级别，不阻断写入，也不改变本 Skill 的实际能力面。补齐时四段守卫的取值必须是：
`resource.direct_resource_access = false`、`resource.access_via_gateway_only = true`、
`owner_binding.binding_resolved_by = "agent_layer"`、`audit.emitted_by = "runtime"`。

社区白名单内的文件仍可满足 CogSeed 侧的形状要求：`references/input-contract.md`、
`references/output-contract.md`、`references/ontology-mapping.md` 分别对应输入契约、输出契约与本体切片，
正文中的封顶声明对应分阶段上限与生产锁。

## 7. 风险等级

本 Skill 按个人低风险只读工具取 L2（路由 Lite）。若被共享、接入私有数据、触发外部动作或被当作元技能
使用，必须上调至 L5；上调属治理工作，不在本包范围内。本包不得声称已达到任何发布级别。
