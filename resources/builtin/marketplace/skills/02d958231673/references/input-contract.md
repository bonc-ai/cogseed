# Input contract — product-copywriting

The skill input is three-layer: `task_id` + `owner_context` + `<primary>_payload`.
`owner_context` values are **injected by the Agent layer at load time** — the skill never
fills owner_id or the real authorization scope.

## <primary>_payload
| field | meaning | unit | source |
|---|---|---|---|
| <field_a> | <business meaning> | <unit> | <source> |

## owner_context (field-positions only; values injected by Agent layer)
| field | meaning |
|---|---|
| `owner_id` | who owns this action (injected) |
| `role` | the owner's role, for policy/permission (injected) |
| `authorization_scope` | what this owner is allowed to do (injected) |

> The skill declares *what it needs*; it does not resolve identity or touch resources
> directly — that is the Agent/Gateway layer's job.
