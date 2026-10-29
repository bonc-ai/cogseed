# Input contract

The guide input has three layers, defined in `../schemas.json`:

- `task_id`: the host task identity.
- `owner_context`: host-injected `owner_id`, `role`, and `authorization_scope`. Declare these positions; do not fill them from prose or pass them as authorization flags.
- `edit_payload`: the user's request, an optional resolved existing target ID, and any version baseline already read. Existing guide callers remain valid.
- `create_payload`: an alternative creation request with the intended `cognition`, `ontology` or `joint` target and any already-read ontology baseline. Do not supply both payloads.

Resolve missing target IDs through the management tools. Ask only for a genuinely ambiguous target or factual effective date. The feature obtains real conversation/message identity from host context; the model cannot supply it through tool input.

For a normal explicit creation request, call `create_cognition` with `mode="apply_if_authorized"` or omit mode. Supply complete content, conditions, scope and necessary new ontology actions. Ontology-only creation uses `explanation` (title, complete change description, future use and scope), not a fabricated cognition asset. The host establishes the new complete human decision through one preview confirmation, rather than borrowing a nightly capture proof or an unrelated old approval. A new source fact without a saving request is not a creation instruction.

For a normal edit request, including AI-authored rewrites, call the tool with `mode="apply_if_authorized"` or omit mode. The host owns any required complete-preview interaction. Choose `mode="propose"` only for an explicit user request to preview without saving; proposing is not the confirmation stage of a normal edit.
