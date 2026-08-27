# Input contract — grounded-material-qa

The skill input is three-layer: `task_id` + `owner_context` + `question_payload`.

## question_payload

| field | meaning | unit | source |
|---|---|---|---|
| `question` | the user's question about the materials | string | caller |
| `scope` | optional: `all` \| `space` \| `global` search scope | string | caller |
| `k` | optional: max evidence hits (default 8, max 30) | integer | caller |

## owner_context (field-positions only; values injected by the Agent layer at load time)

| field | meaning |
|---|---|
| `owner_id` | who asked the question (injected) |
| `role` | the owner's role, for policy/permission (injected) |
| `authorization_scope` | which materials this owner may read (injected; mirrors the path sandbox) |

> The skill declares *what it needs*; it does not resolve identity or touch
> resources directly — that is the Agent/Gateway layer's job.
