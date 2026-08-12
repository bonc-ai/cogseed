# 本体映射

`Business Context = relevant(TBox) + applicable(RBox) + current(ABox)`。

```yaml
tbox:
  WeeklyReviewTask:
    fields:
    - "比较计划与实际，区分完成、投入时间和掌握度"
    - "汇总测验、练习、解释和反馈证据，更新误区日志"
  Evidence: [evidence_id, source_ref, locator, source_tier, confidence]
  CandidateAsset: [candidate_id, asset_type, status, audit_ref]
rbox:
  - {rule_id: R-AUTH-01, if: source_not_authorized, then: block_read, protected: true}
  - {rule_id: R-EVIDENCE-01, if: evidence_is_not_real, then: require_source_tier_and_non_claim, protected: true}
  - {rule_id: R-WRITE-01, if: formal_asset_write_requested, then: emit_candidate_and_require_HITL, protected: true}
  - {rule_id: R-STAGED-01, if: promotion_above_staged_requested, then: reject_and_audit, protected: true}
abox: {}
output_concepts:
    - "week、planned、completed、mastery_delta、misconception等字段"
source_refs:
  - ../SKILL.md
  - method.md
  - ../cogseed-skill.yaml
```

`ABox` 在制品中保持空；当前实例只能由 `task_payload` 在运行时注入，不得把真实客户轨迹写回分发包。
