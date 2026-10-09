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
| DOMAIN-01 | 优先排序问题，再评估解决方案。 | 人工语义复核 |
| DOMAIN-02 | 框架用于组织判断，不替代决策。 | 人工语义复核 |
| DOMAIN-03 | 置信度必须来自证据质量，不得用于美化偏好。 | 人工语义复核 |
| DOMAIN-04 | 总分接近或样本不同质时报告区间/梯队，不伪造精确顺序。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
