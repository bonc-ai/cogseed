# Output contract

输出必须通过 `schemas/output.schema.json`，固定阶段为 `Qualify`，并包含
status、summary、artifact/evidence refs、唯一 next action、`AI Fit & Authority Gate`、
approval required 以及 claims allowed/prohibited。

阶段业务输出覆盖：`ai_fit`, `non_ai_option`, `authority_grant`, `evaluation_obligations`。
这些字段进入 artifact refs 指向的持久资产；摘要不得替代原始事实。输出不包含
人工批准、Level B、发布、全局安装、生产写入或未经证据支持的业务结论。
