# Validation contract — grounded-material-qa

## Boundary tests

1. Question answerable from Library material → grounded answer with `path#chunk N`.
2. Question answerable only from an attachment → grounded answer citing the filename.
3. Question with no material coverage → `no_material`, plain wording, no fabrication.
4. Weak/fuzzy match → `low_confidence` caveat or decline.
5. A fabricated citation is detected and dropped/rewritten before delivery.

## HITL policy

This skill is read-only: retrieval and answering need no confirmation. Any
write/outbound action is out of scope by design; if one is ever requested, it
stops and asks the user.
