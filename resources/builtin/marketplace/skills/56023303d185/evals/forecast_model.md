# Forecast model

本包预测 `Orchestrate` 请求能否形成稳定输出并到达 `next_required_human_gate`。
预测维度：阶段匹配、Evidence 完整性、权限边界、对象/状态完整性、保护面风险。
预测不是 Gate 决定或业务结果。
