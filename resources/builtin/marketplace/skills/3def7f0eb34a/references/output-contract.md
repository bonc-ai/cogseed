# 输出契约

机器规范以 [`../schemas.json`](../schemas.json) 的 `output_schema` 为唯一事实来源。

| 字段 | 位置 | 业务语义 |
|---|---|---|
| actions | `actions[]` | 已执行的只读/候选动作，不包含未执行动作。 |
| trace | `trace[]` | 状态机步骤与停止原因。 |
| audit_refs | `audit_refs[]` | 由运行时生成的 append-only 审计引用。 |
| evidence | `evidence[]` | 带 `real/desensitized/synthetic/manual/stub` 标签的证据。 |
| asset_candidates | `asset_candidates[]` | 仅为候选，不得解释为正式资产写入。 |
| 交付物 1 | `result` / `deliverable` | week、planned、completed、mastery_delta、misconception等字段 |

输出必须区分事实、推断、假设、建议与待决策项；未运行、阻塞或桩结果不得写成通过。
