# NSEAP input/output contract templates (MANDATORY for every new skill)

NSEAP §5.4: every skill MUST have non-empty input and output contracts, written to
`references/input-contract.md` and `references/output-contract.md`. The schema skeleton is
derived from the workflow; the author fills the business field meanings.

## references/input-contract.md

```markdown
# Input contract — <skill-name>

The skill input is three-layer: `task_id` + `owner_context` + `<primary>_payload`.
`owner_context` values are **injected by the Agent layer at load time** — the skill never
fills owner_id or the real authorization scope.

## <primary>_payload
| field | meaning | unit | source |
|---|---|---|---|
| <field_a> | <business meaning> | <unit> | <source> |
| <field_b> | <business meaning> | <unit> | <source> |

## owner_context (field-positions only; values injected by Agent layer)
| field | meaning |
|---|---|
| `owner_id` | who owns this action (injected) |
| `role` | the owner's role, for policy/permission (injected) |
| `authorization_scope` | what this owner is allowed to do (injected) |

> The skill declares *what it needs*; it does not resolve identity or touch resources
> directly — that is the Agent/Gateway layer's job.
```

## references/output-contract.md

```markdown
# Output contract — <skill-name>

The skill output shape is stable on success and failure:

| field | meaning |
|---|---|
| `actions` | what was decided / attempted (string list) |
| `result` | the primary result value |
| `trace` | step trace for replay (string list) |
| `audit_refs` | audit ledger references (string list) |

`audit_refs` is required — the runtime appends audit entries, append-only.
```

## JSON schema companion (optional but recommended)

If the skill needs machine-readable schemas, also write `schemas.json` with `input_schema`,
`output_schema`, and `runtime_contracts` (resource / permission / owner_binding / audit).
Boundary guards that must stay fixed:

```json
{
  "resource": { "access_via_gateway_only": true, "direct_resource_access": false },
  "owner_binding": { "binding_resolved_by": "agent_layer" },
  "audit": { "emitted_by": "runtime" }
}
```
