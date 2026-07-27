# KSTAR Evolution 详细流程

## 五元组

| 字母 | 含义 | 采集方式 |
|------|------|---------|
| K | Knowledge（知识） | Ontology Snapshot 引用 |
| S | Situation（场景） | 会话上下文摘要 |
| T | Task（任务） | 用户查询 |
| A | Action（动作） | Agent 工具调用链 |
| R | Result（结果） | 最终输出 |

## 信号计算

```
DeltaR = actual_result - predicted_result    （核心学习信号）
DeltaA = predicted_action - actual_action    （信任门控信号）
```

## 归因分叉

```
DeltaA ≠ 0?  →  执行问题（修 Skill 工作流/工具绑定）
DeltaA = 0 但 DeltaR ≠ 0?
  ├─ 结果为空 → TBox 缺概念
  ├─ 结果有但错 → RBox 缺规则
  └─ 无法判断边界 → ABox 缺样例
```

## 门控顺序（固定）

1. **Validation Gate** — 回放集整体提升 + 无场景回退
2. **Governance Gate** — 受保护表面零违反
3. **Canary Gate** — 代表性场景金丝雀无退化

## 证据链（不可断链）

```
baseline_skill@hash → episode_id → attribution_id
→ patch_proposal_id → replay_report_id → human_decision_id
→ staged_record_id
```
