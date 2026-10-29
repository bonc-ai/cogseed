# Cognition management ontology slice

## TBox

- ExistingTarget: owner-bound asset or ontology record ID, version, lifecycle, and source references.
- NewTarget: user-requested cognition, ontology or a jointly saved cognition and shared rule.
- CompleteContract: statement, applicable conditions, forbidden conditions, and access boundary.
- EditDecision: actual user message or resolved complete-preview interaction, target, baseline, changed fields, and committed version.
- SharedRule: a rule whose requirement is owned by one asset's complete statement.

## RBox

| Field | Operation | Value | Action |
|---|---|---|---|
| target.ownership | equals | current owner | permit management inspection only |
| source.available | equals | false | deny body disclosure and editing |
| create.intent | equals | explicit current human instruction | prepare the complete new contract for one confirmation |
| create.confirmation | not_equals | complete human allow | do not save formal content |
| edit.precise AND complete_contract.reviewed | equals | true | host validates the bounded delta and continuous decision |
| edit.precise AND complete_contract.reviewed | not_equals | true | show the complete result for one human confirmation |
| current.version | not_equals | prepared baseline | refuse stale commit |
| shared_rule.requirement | equals | asset.statement | save both in one authoritative draft |
| fact.intent | equals | change | require the user's effective date and retain prior validity |

## ABox

The positive and negative examples in `../evals/evals.json` instantiate these rules. They are synthetic contract cases, not user data.

source_refs: `../SKILL.md`, `validation-contract.md`, `../evals/evals.json`.
