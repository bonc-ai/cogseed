# 本体映射

`Business Context = relevant(TBox) + applicable(RBox) + current(ABox)`。

```yaml
tbox:
  RequirementEvidenceTask:
    fields:
    - "决策目标或待回答问题"
    - "一个或多个带来源定位的需求材料"
    - "产品目标、用户分群与已确认规则（如有）"
  Evidence: [evidence_id, source_ref, locator, source_tier, confidence]
  CandidateAsset: [candidate_id, asset_type, status, audit_ref]
rbox:
  - {rule_id: R-AUTH-01, if: source_not_authorized, then: block_read, protected: true}
  - {rule_id: R-EVIDENCE-01, if: evidence_is_not_real, then: require_source_tier_and_non_claim, protected: true}
  - {rule_id: R-WRITE-01, if: formal_asset_write_requested, then: emit_candidate_and_require_HITL, protected: true}
  - {rule_id: R-STAGED-01, if: promotion_above_staged_requested, then: reject_and_audit, protected: true}
abox: {}
output_concepts:
    - "需求主题矩阵"
    - "证据账本与引用"
    - "冲突/反例清单"
    - "假设与验证计划"
    - "开放问题与候选认知资产"
source_refs:
  - ../SKILL.md
  - method.md
  - ../cogseed-skill.yaml
```

`ABox` 在制品中保持空；当前实例只能由 `task_payload` 在运行时注入，不得把真实客户轨迹写回分发包。
