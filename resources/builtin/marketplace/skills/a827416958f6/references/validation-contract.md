# 验证契约

## 机器检查

- `schemas.json` 输入/输出均通过 JSON Schema 形状校验。
- 所有来源属于 `authorized_sources`；`direct_resource_access=false`。
- 高风险候选动作需要 HITL，正式资产直接写入恒为失败。
- `promotion_ceiling=staged` 且 `production_release_allowed=false`。
- 执行成功、评测通过、属主验证均不等于发布批准。

## 业务规则检查

| 规则 ID | 规则 | 责任角色 |
|---|---|---|
| DOMAIN-01 | North Star是客户获得价值的单一指标，不等于收入、OKR或指标列表。 | 人工语义复核 |
| DOMAIN-02 | 活动量不自动等于价值；必须说明价值代理关系。 | 人工语义复核 |
| DOMAIN-03 | 平均值必须配合关键分群，防止掩盖弱势用户。 | 人工语义复核 |
| DOMAIN-04 | AI产品同时跟踪任务成功、采纳/纠正、引用/安全、延迟和成本。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
