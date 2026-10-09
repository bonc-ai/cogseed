# 失败模式与归因

| failure_id | 归因层 | 检测信号 | 降级/安全续跑 |
|---|---|---|---|
| F-AUTH | Policy | 来源或权限不足 | 停止读取，返回所需授权 |
| F-SCHEMA | Skill | 输入/输出不满足契约 | 返回字段级错误 |
| F-TOOL | ToolBinding | 工具/资源不可达或执行走样 | 令 ΔA≠0，禁止用 ΔR 学习 |
| F-EVIDENCE | Eval | 证据冲突、无定位或来源档位缺失 | 保留冲突并降级结论 |
| F-GOV | Policy | 请求绕过 HITL、审计或 staged 封顶 | 拒绝并审计 |
| F-DOMAIN-01 | Workflow | 来源不可用：返回已完成部分、缺口、影响与安全续跑点。 | 按原 Skill 的失败与降级规则处理 |
| F-DOMAIN-02 | Workflow | 证据冲突：并列冲突和适用条件，不静默裁决。 | 按原 Skill 的失败与降级规则处理 |
| F-DOMAIN-03 | Workflow | 权限不足或出现敏感数据：停止对应读取/动作并请求授权。 | 按原 Skill 的失败与降级规则处理 |
| F-DOMAIN-04 | Workflow | 预算耗尽：保留中间证据、未完成步骤和恢复指针。 | 按原 Skill 的失败与降级规则处理 |

归因键必须进入 `trace` 与学习记录。执行走样优先归因 ToolBinding/Execution，不得误写成知识更新信号。
