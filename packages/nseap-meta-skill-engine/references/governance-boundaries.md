# Governance Boundaries

## 受保护表面（任何 Patch 不能碰）

1. **形式规则结构** — 本体中的逻辑公理、约束定义
2. **HITL 要求** — 高风险操作的人工审批要求
3. **审计机制** — 全链路可追溯的审计记录

## 可变表面（可以 Patch）

1. **配置键** — 运行时参数、环境变量
2. **阈值权重** — 置信度阈值、触发条件数值
3. **策略开关** — 功能开关、路由策略

## 晋升路径

```
Personal Candidate → Personal Adopted → Team Candidate
→ Team Baseline → Enterprise Candidate → Enterprise Baseline
```

## 硬边界不等式

- `Candidate ≠ Staged`
- `Staged ≠ Release_Ready`
- `Release_Ready ≠ Production_Release`
- `DeltaR ≠ Release_Command`
- `Execution_Success ≠ Release_Approval`

## Meta-Skill 特殊约束

- `promotion_ceiling: staged` — 最高到暂存
- `production_release_allowed: false` — 永远不能自动上线
- `max_self_patch_ops: <=2` — 自补丁编辑预算
- `max_self_patch_depth: 1` — 递归深度限制
