# Replay dataset

数据集由 `evals/evals.json` 的 10 条 synthetic case 构成，IDs 前缀为
`EVAL-LEARN-`。它用于本地包级回放，不证明真实用户价值。实质变更需重跑
这些 case 和 suite manifest 冻结的 12 条实际 runtime E2E。
