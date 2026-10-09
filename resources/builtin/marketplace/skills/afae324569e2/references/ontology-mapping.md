# 本体映射

`Business Context = relevant(TBox) + applicable(RBox) + current(ABox)`。

```yaml
tbox:
  CompetitorMarketResearchTask:
    fields:
    - "决策问题、目标用户与产品边界"
    - "候选竞品或待扫描市场"
    - "允许访问的内部材料与外部来源范围"
  Evidence: [evidence_id, source_ref, locator, source_tier, confidence]
  CandidateAsset: [candidate_id, asset_type, status, audit_ref]
rbox:
  - {rule_id: R-AUTH-01, if: source_not_authorized, then: block_read, protected: true}
  - {rule_id: R-EVIDENCE-01, if: evidence_is_not_real, then: require_source_tier_and_non_claim, protected: true}
  - {rule_id: R-WRITE-01, if: formal_asset_write_requested, then: emit_candidate_and_require_HITL, protected: true}
  - {rule_id: R-STAGED-01, if: promotion_above_staged_requested, then: reject_and_audit, protected: true}
abox: {}
output_concepts:
    - "研究范围与竞品池"
    - "来源登记与证据矩阵"
    - "能力/定位/商业模式对比"
    - "机会威胁与产品含义"
    - "证据缺口和下一步"
source_refs:
  - ../SKILL.md
  - method.md
  - ../cogseed-skill.yaml
```

`ABox` 在制品中保持空；当前实例只能由 `task_payload` 在运行时注入，不得把真实客户轨迹写回分发包。
