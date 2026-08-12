# Input contract

输入必须通过 `schemas/input.schema.json`，并包含 task ID、`PV-...` 产品版本、
owner 上下文和 `Launch & Learn` 阶段输入。阶段字段至少包括：
`release_decision_ref`, `real_run_refs`, `outcome_definition`。

事实、假设、来源和决定必须分开。不得输入秘密、生产令牌、推测的 owner 批准、
虚构日期或未脱敏私密数据。缺少必要上下文时返回澄清，不使用种子或旧快照替代。
