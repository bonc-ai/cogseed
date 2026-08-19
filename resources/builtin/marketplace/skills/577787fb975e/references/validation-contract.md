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
| DOMAIN-01 | 事实、假设、建议和已批准决策必须分层。 | 人工语义复核 |
| DOMAIN-02 | 每个Must需求必须有来源或决策依据。 | 人工语义复核 |
| DOMAIN-03 | PRD不代替技术方案；未知技术选择标TBD。 | 人工语义复核 |
| DOMAIN-04 | 对外承诺、路线图和正式PRD覆盖需人工批准。 | 人工语义复核 |

## 结果

只允许 `pass / fail / blocked / not_run`。返回码 0 只说明检查器完成；缺证据、桩结果或 dry-run 不得记为验证通过。
