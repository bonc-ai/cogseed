# Validation contract

- 包根 16 个标准资产与 4 个机器增强资产齐全且无 symlink。
- 输入/输出 Schema 为 Draft 2020-12，根对象封闭。
- Skill stable ID、name、version、manifest 与目录一致。
- 10 个 EvalCase、4 个负例、五类 coverage 与两个 manifest 精确对账。
- 阶段输出必须请求 `Discovery Gate`，工具不得代填 owner decision。
- Evidence、Decision、ProductVersion 与 artifact refs 可追溯。
- 任何保护面失败、摘要漂移、未知归因或禁止动作均阻断；不能平均抵消。
