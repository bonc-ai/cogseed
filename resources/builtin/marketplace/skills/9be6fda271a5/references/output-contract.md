# Output contract — material-organizer

The skill output shape is stable on success and failure:

| field | meaning |
|---|---|
| `actions` | what was decided / attempted (string list) |
| `result` | the primary result value |
| `trace` | step trace for replay (string list) |
| `audit_refs` | audit ledger references (string list) |

`audit_refs` is required — the runtime appends audit entries, append-only.
