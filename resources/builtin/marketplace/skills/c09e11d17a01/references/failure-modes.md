# Failure handling

- Ambiguous target: return metadata choices and ask the user to identify one.
- Stale baseline: reread the existing target and re-evaluate the user's actual requested delta.
- Revoked source: stop; do not use file, shell, alternate tools, or previews to retrieve the body.
- Rejected/cancelled confirmation: report not saved and stop.
- Shared-body mismatch: keep both copies unchanged and correct the requested joint change.
- Missing host conversation identity: do not fabricate identity or a confirmation receipt.
- Creation collides with an existing item: inspect the named existing target; do not silently overwrite it or keep creating duplicates.
- Missing create tool: state the unavailable capability; do not claim a candidate was created or saved by conversational acknowledgment.
