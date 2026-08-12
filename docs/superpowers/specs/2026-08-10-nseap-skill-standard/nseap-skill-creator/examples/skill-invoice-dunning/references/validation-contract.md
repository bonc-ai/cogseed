# Validation contract — invoice_dunning

## Boundary tests
- **B1**: amount_overdue = 1500, days_overdue = 45 → R1 fires → route = human_review, no auto-send.
- **B2**: amount_overdue = 200, days_overdue = 10 → no R1 → route = auto_remind (staged draft only).
- **B3**: is_vip = 1 → R2 fires → relationship_first before any dunning wording.

## HITL policy (human-in-the-loop)
- Any `execute` (send/charge) requires `confirm` (HITL) — the workflow gate.
- R1 (large + aged) **forces human review** before execute, regardless of confidence.
- High-risk = write action on a real customer → always HITL.

## Invariants
- `ΔA gates ΔR`: if the executed action differs from the intended one, the outcome signal
  is distrusted (not used to learn).
- `staged is not production release`: a passing validation is a staged draft, never a send.
