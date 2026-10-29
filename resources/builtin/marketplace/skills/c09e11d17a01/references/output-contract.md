# Output contract

Return `status`, a short `result`, and `audit_refs` containing only actual returned decision/version references. Keep these references in the execution record unless the user asks for them.

- `applied`: the host saved and read back the new item or changed version; use its actual IDs, version and receipt.
- `pending_confirmation`: content has not been saved. In preview-only mode no approval card was opened; a real host approval flow must be resolved before reporting a successful write.
- `blocked`: identify the target, source, version, or denied confirmation that prevents saving; do not invent a receipt.

For a short user reply, explain what was created or changed and whether it took effect. An uncommitted proposal is not a completed write.
