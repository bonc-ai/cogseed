# Forecast model — customer-profile-presales（stub，作者待填）

L4+ 一等评测的**预测**侧：执行前给出预期，执行后比对（见 outcome_evaluation.md）。

预测字段（每次产出作战方案时记录）：
- `expected_deck_version` / `expected_granularity` / `expected_talk_track`：由 RBox 路由预测。
- `expected_objection_hits`：由 known_impression → QA 库预测应命中的异议 id 集。
- `forecast_confidence`：0–1，映射覆盖度置信。
- `expected_cost` / `expected_latency`：目标口径（如"一分钟内产出七项方案"）。

> 诚实边界：预测/实际闭环的真实运行需 metaskill 引擎；本 stub 只声明字段契约。
