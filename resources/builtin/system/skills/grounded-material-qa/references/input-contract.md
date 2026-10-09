# Input contract — grounded-material-qa

Input is a question plus optional scope, split into identity, caller context,
and payload:

| part | meaning |
|---|---|
| `caller` | who asked (resolved by the Agent layer at load time, never by this skill) |
| `authorization_scope` | which materials the caller may read (resolved by the Agent layer; mirrors the path sandbox) |
| `question` | the user's question about the materials |
| `scope` | optional: `all` \| `space` \| `global` search scope |
| `k` | optional: max evidence hits (default 8, max 30) |

> The skill declares *what it needs*; it does not resolve identity or touch
> resources directly — that is the Agent/Gateway layer's job.
