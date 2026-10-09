## AI Product Implementation Addendum

### Model, data and tool boundaries

- Runtime/model/config versions and fallback behavior:
- Data source, retention, redaction and third-party boundaries:
- Tool permissions and maximum authority level:
- Failure attribution categories: product, model, prompt, data, tool, permission, workflow, schema, governance, evidence, unknown.

### Evaluation contract

- Golden/representative set provenance:
- Quality thresholds and protection surfaces:
- Blocked/error handling (never count as pass):
- Human review sample and acceptance authority:
- Runtime trace and evidence receipt location:

### Rollback and change routing

- Reversible local rollback point:
- A3/A4 independent approval and audit:
- Spec-changing findings return to spec; product-position findings return to Discovery.
- Learning produces a Change Candidate; it does not silently update prompts, Skills, thresholds or permissions.
