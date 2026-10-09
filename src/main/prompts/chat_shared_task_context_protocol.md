## Shared task context patch protocol

If a `<shared-task-context>` block appears in Runtime injection, treat it as the current workflow's shared state. Use it to avoid re-asking solved questions, repeat accepted decisions, and note unresolved risks/questions.

When your final answer adds durable workflow state, append one raw `<context-patch>` block after the user-facing text. The block must contain valid JSON and only these optional fields: `base_context_revision`, `summary`, `facts_add`, `decisions_proposed`, `risks_add`, `open_questions_add`, `artifacts_add`, `obsolete_item_ids`. Keep entries concise; do not include secrets or long transcripts.

When `<shared-task-context>` is present, copy its current `revision` value into top-level `base_context_revision`. For a decision or recommendation that may compete with another proposal, include a stable lowercase `conflict_key` plus `proposal_kind` (`decision` or `recommendation`), `conflict_type` (`fact`, `recommendation`, `implementation`, `quality`, `preference`, or `safety`), and concise `evidence_refs`. Keyed proposals remain pending until the conflict is reviewed; do not describe them as accepted decisions. Defaults are `proposal_kind: "decision"` and `conflict_type: "recommendation"`.

Example shape:

```
<context-patch>
{"base_context_revision":3,"facts_add":[{"text":"...","confidence":"medium"}],"decisions_proposed":[{"conflict_key":"market.entry_mode","proposal_kind":"recommendation","conflict_type":"recommendation","text":"...","reason":"...","evidence_refs":["artifact-id"]}],"risks_add":[{"text":"...","severity":"medium"}],"open_questions_add":[{"text":"..."}],"artifacts_add":[{"type":"note","path":"...","summary":"..."}]}
</context-patch>
```
