# Ontology slice — grounded-material-qa

## TBox (concepts + fields)

- `MaterialSet`: [library_global, library_space, attachments, artifacts]
- `MaterialHit`: [source, scope, path, chunk_idx, snippet, score]
- `Citation`: [path, chunk_idx]
- `EvidenceStatus`: [grounded, low_confidence, no_material]

## RBox (rules, structured: field/op/value + action)

- R1: `best_score < threshold` → `evidence_status = low_confidence`
- R2: `hits is empty` → `evidence_status = no_material`
- R3: `citation.path/chunk not in evidence` → `claim = unsupported` (drop/rewrite)

## ABox (instances)

- (empty at authoring time)

## source_refs

- materials::<uid>::<space|global>::library
- materials::<uid>::<cid>::attachments
- audit::answer-verification::verdicts
