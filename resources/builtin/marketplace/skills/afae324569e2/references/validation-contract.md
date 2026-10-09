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
| DOMAIN-01 | 研究范围由决策问题驱动，不固定竞品数量。 | 人工语义复核 |
| DOMAIN-02 | 官网营销话术属于厂商主张，不自动视为已验证事实。 | 人工语义复核 |
| DOMAIN-03 | 价格、版本、负责人、发布日期等易变信息必须带时间。 | 人工语义复核 |
| DOMAIN-04 | 无法核实的市场份额、客户数和性能数据不得填补。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
