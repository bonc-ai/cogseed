# 本体映射

`Business Context = relevant(TBox) + applicable(RBox) + current(ABox)`。

```yaml
tbox:
  ProductMetricsTask:
    fields:
    - "用户价值与业务模式"
    - "核心用户旅程和产品阶段"
    - "现有数据源、埋点、目标和约束"
  Evidence: [evidence_id, source_ref, locator, source_tier, confidence]
  CandidateAsset: [candidate_id, asset_type, status, audit_ref]
rbox:
  - {rule_id: R-AUTH-01, if: source_not_authorized, then: block_read, protected: true}
  - {rule_id: R-EVIDENCE-01, if: evidence_is_not_real, then: require_source_tier_and_non_claim, protected: true}
  - {rule_id: R-WRITE-01, if: formal_asset_write_requested, then: emit_candidate_and_require_HITL, protected: true}
  - {rule_id: R-STAGED-01, if: promotion_above_staged_requested, then: reject_and_audit, protected: true}
abox: {}
output_concepts:
    - "指标树/指标分层"
    - "完整指标字典"
    - "数据可得性与埋点缺口"
    - "目标/阈值/护栏"
    - "实验与发布Gate映射"
source_refs:
  - ../SKILL.md
  - method.md
  - ../cogseed-skill.yaml
```

`ABox` 在制品中保持空；当前实例只能由 `task_payload` 在运行时注入，不得把真实客户轨迹写回分发包。
