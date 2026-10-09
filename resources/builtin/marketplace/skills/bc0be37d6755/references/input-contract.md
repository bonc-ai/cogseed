# 输入契约

机器规范以 [`../schemas.json`](../schemas.json) 的 `input_schema` 为唯一事实来源。

| 字段 | 位置 | 业务语义 |
|---|---|---|
| task_id | `task_id` | 本次执行的稳定任务标识，不得复用为用户身份。 |
| owner_context | `owner_context` | 由 Agent 层注入的属主和授权范围；Skill 不解析身份。 |
| task_snapshot | `task_payload.task_snapshot` | 版本固定的任务请求和已确认约束。 |
| authorized_sources | `task_payload.authorized_sources` | 允许读取的来源引用；不包含凭证正文。 |
| 业务输入 1 | `task_payload.domain_context` | 产品目标、成功指标和时间范围 |
| 业务输入 2 | `task_payload.domain_context` | 候选问题/方案及证据 |
| 业务输入 3 | `task_payload.domain_context` | 资源、依赖、风险和决策约束 |

空的 `task_id`、缺失 `owner_context`、缺少授权来源或无法确认的关键业务输入均不得进入执行工作流；返回 `blocked` 或最少必要问题。
