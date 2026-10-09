# Output contract — grounded-material-qa

The skill output shape is stable on success and failure:

| field | meaning |
|---|---|
| `answer` | the grounded answer (string) |
| `citations` | list of `path#chunk N` anchors used (string list) |
| `evidence_status` | `grounded` \| `low_confidence` \| `no_material` |
| `trace` | step trace for replay (string list) |
| `audit_refs` | audit references (string list; the runtime appends audit entries, append-only) |

Failure modes are structured, not silent:

- `no_material`: no relevant evidence found; the answer states this plainly.
- `low_confidence`: matches below the relevance threshold; the answer carries a
  caveat or declines.
- `unsupported`: a proposed citation does not exist in the evidence; the claim
  is dropped or rewritten before delivery.
