# Input contract — business meaning of each field

The skill input is three-layer: `task_id` + `owner_context` + `invoice_payload`.
`owner_context` values are **injected by the Agent layer at load time** — the skill never
fills owner_id or the real authorization scope.

## invoice_payload
| field | meaning | unit | source |
|---|---|---|---|
| `amount_overdue` | outstanding balance past due on the invoice | currency (minor unit or major, be consistent) | billing system (via Gateway) |
| `days_overdue` | days since the due date | integer days | derived: today − due_date |
| `is_vip` | whether the account is a VIP/strategic customer | 0/1 | CRM tier flag |

## owner_context (field-positions only; values injected by Agent layer)
| field | meaning |
|---|---|
| `owner_id` | who owns this collection action (injected) |
| `role` | the owner's role, for policy/permission (injected) |
| `authorization_scope` | what this owner is allowed to do (injected) |

> The skill declares *what it needs*; it does not resolve identity or read the billing
> system directly. That is the Agent/Gateway layer's job.
