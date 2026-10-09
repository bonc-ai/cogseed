# AI Product Lifecycle Workflow

这个 Workflow 把 AI 产品发现与治理接到原生 Spec Kit。它不会替代核心命令，也不会自动
外发、发布或更改权限。

## Inputs

- `spec`: 产品机会、迭代或诊断描述。
- `entry_mode`: `zero_to_one | iteration | diagnosis`。
- `integration`: 默认 `auto`，继承项目 integration。

首要不确定性由 `route` 后的 `review-route` 人工 Gate 选择，不是 workflow 输入参数。
可选 `value | experience | ai-capability | integration | governance | clear | unknown | reject`。
若选择 `unknown`，流程先做 Frame 补证据；
Discovery Gate 不应在首要不确定性仍未知时批准。

## Human gates

1. Route review
2. Discovery Gate
3. AI Fit & Authority Gate
4. Spec Handoff Gate
5. Native analysis review
6. Release Readiness Gate
7. Learning & Evolution Gate

`specify workflow resume <run-id>` 用于人工决定后恢复。Reject 默认终止，保留运行状态和
已生成候选。Gate 只控制流程顺序，不授予操作系统、外部 SaaS 或生产权限。

## Native core handoff

Discovery/Authority/Handoff 通过后，Workflow 调用原生：

```text
speckit.specify → speckit.plan → speckit.tasks → speckit.analyze → speckit.implement
```

扩展不提供这些核心命令的替代版本。

## Safety

- 无 shell step，也不把用户输入插入 shell。
- A4 默认禁止；A3 仍需宿主工具独立批准。
- Release Readiness Gate 不等于发布决定。
- Launch & Learn 在缺少独立发布/数据访问决定时必须返回 blocked。
