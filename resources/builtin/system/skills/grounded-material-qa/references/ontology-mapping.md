# Domain mapping — grounded-material-qa

## Concepts

- `MaterialSet` — the answer boundary: [library_global, library_space, attachments, artifacts]
- `MaterialHit` — a retrieval result: [source, scope, path, chunk_idx, snippet, score]
- `Citation` — [path, chunk_idx]
- `EvidenceStatus` — [grounded, low_confidence, no_material]

## Rules

- R1: `best_score < threshold` → `evidence_status = low_confidence`
- R2: `hits is empty` → `evidence_status = no_material`
- R3: `citation.path/chunk not in evidence` → `claim = unsupported` (drop/rewrite)

## Instances

- (empty at authoring time)

## Data references

- materials::<uid>::<space|global>::library
- materials::<uid>::<cid>::attachments
- verification::answer_verification::verdicts
