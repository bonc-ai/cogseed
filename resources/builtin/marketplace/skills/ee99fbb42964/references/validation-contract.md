# Validation contract — deep-research

## Boundary tests
- B1: <input A> → <expected route/decision>
- B2: <input B> → <expected route/decision>

## HITL policy (human-in-the-loop)
- Any \`execute\` (write) requires \`confirm\` (HITL) — the workflow gate.
- <high-risk condition> forces human review before execute.

## Invariants
- \`ΔA gates ΔR\`: if the executed action differs from the intended one, the outcome
  signal is distrusted (not used to learn).
- \`staged is not production release\`: a passing validation is a staged draft.
