---
name: cognition-editor
description: "Create or edit durable cognition and ontology through governed tools; For: 'remember this as a preference', 'create this project fact', 'change this rule'; Triggers: create cognition, remember this, edit cognition, correct ontology, change preference."
---

# Create or edit cognition

## When to use

use_when:
- The user explicitly requests creating or saving durable cognition or ontology.
- The user explicitly names existing cognition and requests a bounded edit.
- A stored fact needs correction or a dated real-world change.

do_not_use_when:
- The user only asks a task question or provides material without requesting durable creation or an existing-record edit.
- The user asks to bypass source revocation, enable paused content implicitly, or write raw storage.

Separate an explicit creation request from an edit of an existing target. Ordinary task answers and facts discovered during work do not authorize saving durable content. Do not promise to create a candidate without an available tool and its actual receipt.

## Preconditions and result

Use the current host-provided task and owner context; never invent identity or authorization. The required tools must be available. Return a short account of the actual state and changed content; retain the returned decision/version references as `audit_refs`. See `references/input-contract.md` and `references/output-contract.md` for the guide contract.

## Create new cognition or ontology

1. Confirm that the current user asks to create or save durable content. Keep the request's topic and boundaries; do not treat an assistant suggestion or a routine acknowledgment as authorization. The host verifies the actual user message, not an identity supplied in tool arguments.
2. Inspect relevant existing items and ontology structures to avoid duplicates or invented identities. If the request actually changes an existing item, use the edit workflow. Do not choose another target merely to avoid a conflict.
3. Call `create_cognition` with `target="cognition"`, `"ontology"`, or `"joint"`, the complete supported content and conditions, any necessary new ontology actions, and the actual baseline. For ontology-only creation, provide `explanation` with the complete change description, title, future use and scope; do not invent a cognition asset. The host owns source references and the complete creation decision. For a joint shared rule, its requirement must be the same complete cognition body; do not keep an independent second copy. Do not invent executable conditions or effects from natural-language obligations. If validation reports field paths, correct that bounded argument shape. Never evade a requested joint save by splitting it into separate writes, dropping the ontology, removing meaningful fields or trying another target.
4. Use `mode="apply_if_authorized"` or omit it for a normal creation request. The host displays the complete new content, conditions, scope and associated ontology for one human confirmation before saving. Do not ask a separate conversational confirmation first. Use `mode="propose"` only when the user asks to preview without saving; it does not open approval or create formal content.
5. Report only the actual returned state, new identity/version and receipt. Cancellation, a stale baseline or unavailable source is not a successful creation. Saving does not raise maturity or bypass ordinary next-turn qualification.

## Edit an existing target

1. Resolve the named existing target. Use `list_ability_assets` for asset metadata. Read the target with `read_ability_asset` and `mode="manage"`, or `cognition_ontology_query` with `mode="manage"` and its record ID or exact name. Read every body chunk and the applicability and exclusion conditions. Ask the user to choose when names are ambiguous.
2. Preserve everything outside the requested change. For one quoted fragment, pass `replaceText={"before":"exact old fragment","after":"exact replacement"}`; the old fragment must occur exactly once. For a whole new body use `fields.statement` instead. Never send both body representations, and never put the unchanged old body in `fields` as a baseline: use the version fields for that. Other explicit field changes also use `fields`. Do not silently paraphrase a precise user replacement. A rejected argument-shape error that saved nothing may be corrected within the same bounded turn; a human rejection is not permission to try again.
3. Call `edit_cognition` with the existing target, changes, returned version baselines, the reason, and `mode="apply_if_authorized"` (the default). This is the normal edit path even when you draft or polish the new wording: the host presents the complete preview and waits for one human decision before saving when needed. Do not choose `propose` merely because you wrote the wording, and do not add a separate conversational confirmation. Use `mode="propose"` only when the user explicitly asks to see a plan/preview without saving yet; that mode returns preview text, requests no approval, and saves nothing. For a factual correction use `factIntent="correct"`; for a real-world change use `factIntent="change"` and the user's effective date. Do not guess that date.
4. Let the host resolve shared rule ownership and save the asset and linked ontology together. Include necessary existing linked ontology changes in `ontologyChanges`; never edit a second body copy separately. The host presents one complete preview when rewriting, when the previous complete contract lacks a valid human decision, or when structural/access/additional impacts need review.
5. Report the returned state. Only `status="applied"` means saved; use the returned version and receipt. `pending_confirmation` is only a preview, and `blocked` means nothing was saved. Do not claim an edit worked from a proposed patch alone.

## Boundaries

- Use governed tools, not file or shell writes, for cognition and ontology storage. Never manufacture nightly provenance, use a manual flag to bypass a creation gate, or edit an unrelated candidate pool.
- The actor receiving the actual human instruction owns the write. A delegated worker may draft content but cannot promote a dispatch message into a human authorization.
- Managing a paused or owner-only item does not enable it for tasks. Revoked-source text remains unreadable.
- A verified precise edit continues the person's existing complete decision. Otherwise the complete new body and conditions require one human confirmation. Neither a model-authored origin label nor an old unrelated approval supplies authority.
- Saving does not verify effectiveness, grant tools, bind a Skill to an asset, or broaden access. Subsequent ordinary tasks use the saved current version only within its live source, scope, condition, and lifecycle boundaries.

## Example

User: “Remember this as a preference: technical explanations should start with the conclusion, then give evidence; do not apply it to casual greetings.”

Inspect relevant existing cognition, then call `create_cognition` with the complete preference and both boundaries. Let the host show the complete creation preview once. Say it was saved only after the tool returns `applied` with the new identity and receipt.

User: “In the asset ‘Technical explanations’, replace ‘give the conclusion first’ with ‘give the evidence first’; leave its other conditions unchanged.”

Read that named asset in management mode, then call `edit_cognition` with `mode="apply_if_authorized"`, its ID, the exact `replaceText`, both returned asset version baselines, and the user's instruction as the reason. Do not rewrite the rest of the statement or its conditions.

Negative example: “What should I put in this week’s report?” Use current information to answer the task; do not edit or create durable cognition.
