# 输入契约

机器规范以 [`../schemas.json`](../schemas.json) 的 `input_schema` 为唯一事实来源。

| 字段 | 位置 | 业务语义 |
|---|---|---|
| task_id | `task_id` | 本次执行的稳定任务标识，不得复用为用户身份。 |
| owner_context | `owner_context` | 由 Agent 层注入的属主和授权范围；Skill 不解析身份。 |
| task_snapshot | `task_payload.task_snapshot` | 版本固定的任务请求和已确认约束。 |
| authorized_sources | `task_payload.authorized_sources` | 允许读取的来源引用；不包含凭证正文。 |
| 业务输入 1 | `task_payload.domain_context` | 从验收标准、接口和故障模式建立风险测试矩阵 |
| 业务输入 2 | `task_payload.domain_context` | 选择单元/集成/契约/E2E/性能/安全层，准备确定性夹具 |

空的 `task_id`、缺失 `owner_context`、缺少授权来源或无法确认的关键业务输入均不得进入执行工作流；返回 `blocked` 或最少必要问题。
