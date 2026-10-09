# Failure modes

| Failure | Required behavior |
|---|---|
| 阶段不匹配 | 路由到正确 Stage Skill，不勉强执行 |
| 缺 Evidence/source | `blocked`，列出缺口，不猜测 |
| 缺 owner 决定 | 停在 `Discovery Gate` |
| Schema/manifest 不一致 | `returned`，归因 `schema` |
| 工具/runtime 不可用 | `blocked`，归因 `tool`，不回退 stub 冒充 |
| 请求发布/生产/全局安装 | 拒绝，归因 `permission/governance` |
| 未知失败 | `returned`，`attribution_status=pending` |
| 保护面回归 | 整体失败，不能用平均分抵消 |
