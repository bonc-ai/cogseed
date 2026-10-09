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
| DOMAIN-01 | 客户可以描述问题和期望结果，但不直接决定产品解法。 | 人工语义复核 |
| DOMAIN-02 | 重复提及不等于高价值；样本偏差和客户权重必须显式。 | 人工语义复核 |
| DOMAIN-03 | 没有原始定位的结论不得标为事实。 | 人工语义复核 |
| DOMAIN-04 | 相互冲突的证据不得用平均化叙述掩盖。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
