# KSTAR Continue Message Preload Candidate Card

## Scope

When a user message is routed as `continue` while the conversation has an open KSTAR task and requirement, the system creates a fresh Recall projection preview and posts the existing Commander projection card for that message.

This change does **not** create a new KSTAR task or requirement. It does **not** add topic-switch card handling, workspace/project filtering, or a new asset model.

## Design

- Keep the existing `KstarRequirementRecord.projectionId` as the latest projection associated with the open requirement.
- On `continue`, append the message id to the existing requirement, preserve the requirement title and task identity, and call the existing `previewTaskBoundary` helper using the current user message as the projection purpose/task text.
- Persist the returned projection id on the requirement and return it as `projectionPreviewCreated`.
- Reuse the existing group-chat bridge: when `projectionPreviewCreated` is present, `bus.ts` posts a Commander message containing `recall_projection_card`.
- Empty automatic matches continue to produce a visible card; the renderer already supports manual candidate addition.

## Invariants

- `continue` keeps the same task id, requirement id, and open requirement status.
- Each continued user message gets a new projection record/card.
- The previous card remains addressable by its message payload; the requirement pointer moves to the latest preview for lifecycle/wake compatibility.
- Existing `new`, `complete`, and `topic_switch` routing behavior remains unchanged.
- Workspace/project scope is intentionally not added to the automatic bus trigger in this change.

## Verification

Add a regression test proving that a continued message:

1. does not create another requirement;
2. creates a projection preview;
3. returns `projectionPreviewCreated`;
4. stores the latest projection id on the open requirement.

Run the focused KSTAR requirement-state and group-chat preview tests, then typecheck.
