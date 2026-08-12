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
| DOMAIN-01 | 功能验收与Agent质量Evaluation不可混为一个通过率。 | 人工语义复核 |
| DOMAIN-02 | 能力指标和信任安全指标分开报告，安全硬失败不得被平均分抵消。 | 人工语义复核 |
| DOMAIN-03 | Golden样例必须有来源和真值Owner。 | 人工语义复核 |
| DOMAIN-04 | 结构校验通过不等于任务质量或发布Gate通过。 | 人工语义复核 |
| DOMAIN-05 | 没有真实运行证据时，E0–E5对应层必须保持not_run；业务内容阻塞另列Gate，不冒充Eval状态。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
