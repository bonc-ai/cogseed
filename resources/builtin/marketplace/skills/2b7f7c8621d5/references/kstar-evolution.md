# KSTAR 演进契约

状态：`declared_hook_not_run`。本文件声明闭环，不表示系统已经学习。

1. 执行前记录 `K/S/T → Â/R̂`；执行后记录 `A/R`。
2. `ΔA = A - Â`；`ΔR = R - R̂`。若 `ΔA ≠ 0`，则 `ΔR` 不可信，只用于工具、权限或执行诊断。
3. 一份证据只产生一条学习记录和至多一个假设。
4. 按稳定符号键聚合，`support_threshold: 2` 条独立证据后方可提案。
5. `edit_budget: 2`；补丁只能修改声明的 mutable_surface，永不触碰 protected_surface。
6. 门禁顺序固定为 `Validation → Governance → Canary`；任一失败进入 append-only 拒绝缓冲。
7. 通过三门后也至多形成 `staged` 候选；人工发布决策独立存在。
