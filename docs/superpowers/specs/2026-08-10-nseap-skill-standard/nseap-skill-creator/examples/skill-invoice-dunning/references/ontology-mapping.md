# Ontology slice — invoice_dunning

## TBox (concepts + fields)
- `Invoice`: `amount_overdue`, `days_overdue`, `is_vip`

## RBox (rules — structured; `formal` is human-only, never machine-parsed)
| rule_id | formal | field | op | value | action |
|---|---|---|---|---|---|
| R1 | 金额>1000 且逾期>30天 → 走人工复核（HITL） | days_overdue | gt | 30 | null |
| R1b | （同 R1 的金额分量） | amount_overdue | gt | 1000 | null |
| R2 | VIP 客户先关系维护再催 | is_vip | eq | 1 | relationship_first |

`relationship_first` is a **learnable policy** (default off); the KSTAR loop may toggle it
based on ΔR — the scaffold only declares the hook, it does not run the learning.

## ABox
Empty at authoring time (instances arrive at runtime).

## Traceability (source_refs)
- `materials::invoice_dunning::snapshot`

Platform ontology-registry binding is **target-state** (waits on the schema-authority
decision). A local snapshot ref is the honest field-position for now.
