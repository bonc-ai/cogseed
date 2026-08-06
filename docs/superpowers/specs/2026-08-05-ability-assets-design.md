# Ability Assets Design

Approved direction: align the Skills/Cognition center with the CogSeed PRD and HTML prototype.

## Concept boundaries

- Skill is an execution component and stays in the Skills library. Marketplace/custom skills do not automatically become assets.
- CognitionCandidate is the认知候选 / 待沉淀对象. It is discovered from sessions, artifacts, execution evidence, or teaching signals and must be reviewed before becoming formal.
- AbilityAsset is the正式能力资产 owned by the user. It has stable identity, category, source, version/scope/maturity, governance actions, workspace references, and evidence/use records.

## Page semantics

Top tabs remain: Overview / Skills / Cognition Candidates / Reuse Receipts / Ability Assets.

- Overview shows system state: candidates, formal ability assets, reuse receipts, pending evaluation/risk.
- Skills keeps the original Skill Library behavior only.
- Cognition Candidates shows candidate cards with: my judgment, source/evidence, uncertainty, suggested category/scope, and user choices.
- Reuse Receipts is evidence/audit: Transfer Proof, Effectiveness Proof, evidence sufficiency, invalid/rework states.
- Ability Assets contains internal views: Asset List / Cognition Tree / Usage Records. The Asset List uses four PRD categories: personal, rule, template, skill_method.

## MVP implementation boundary

For this branch, Ability Assets must stop listing marketplace skills as assets. The backend exposes ability-asset-shaped rows from formal-ish sources already available locally:

- Personal ontology groups become `personal` ability assets.
- p3394 experience candidates become `rule` buds.
- p3394 patch candidates become `skill_method` buds.
- Memory entries are not top-level ability assets.
- Skills are only referenced by ability assets/candidates, never auto-promoted.

The renderer should show the Assets tab as Ability Assets with internal Asset List / Cognition Tree / Usage Records, not a generic technical asset catalog.
