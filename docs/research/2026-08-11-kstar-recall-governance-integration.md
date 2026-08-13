# KSTAR × Recall Governance Integration

Date: 2026-08-12

## Summary

This change consolidates KSTAR learning, Recall asset governance, task-level preload selection, execution proof, and effectiveness feedback into one Recall-owned flow.

Recall is the canonical ability-asset model. KSTAR may create review-backed candidates, but a candidate becomes a reusable ability asset only through an explicit user promotion. For each new requirement boundary, the app creates and posts a preload-candidate card even when automatic matching returns zero assets. The Agent supplies the initial recommendation; the user may add or remove candidates before confirming the task preload.

The obsolete P3394/KSTAR Patch Candidate line has been removed end to end. It is no longer shown as a review center, exposed through IPC, projected into Cognition, or retained as a typed legacy-state feature.

## Product behavior

### 1. Candidate governance

- KSTAR review/AAR output may produce a Recall candidate.
- Promotion requires `actor: user`.
- Formal assets support structured scope policy, version history, audit records, pause/resume/revoke, and recommendation acknowledgement.
- Revoked assets remain terminal and cannot be silently modified or reused.

### 2. Preload candidates for every requirement

- A requirement-boundary projection is created for each KSTAR requirement.
- A visible preload-candidate card is posted even when automatic matching returns no assets.
- Automatically matched assets are the Agent's recommendation, not a final decision.
- The user may add or remove assets in the projection draft.
- Confirmation locks the asset/version snapshot used by the execution path.

### 3. Execution and effectiveness closure

- Confirmed Mate/KSTAR execution provenance flows into Recall transfer proofs.
- Successful transfer advances asset maturity to `transfer_validated`.
- Positive effectiveness evidence may advance maturity to `effectiveness_validated`.
- Negative or rework feedback creates a system recommendation on the related asset.
- Recommendations do not automatically mutate, pause, or revoke an asset; the user retains governance control.

## Removed P3394 Patch Candidate surfaces

Removed:

- `CompatPatchCandidate` and patch projection helpers.
- Legacy `patch_candidates` typed state and mutation APIs.
- `p3394.listPatchCandidates` and `p3394.reviewPatchCandidate` IPC routes.
- Renderer `/patch-candidates` shim routes.
- KSTAR Patch Candidate review-center cards, empty/loading/error states, actions, styles, and locale keys.
- Conversation attention items for patch candidates.
- Cognition candidate/asset mappings for `p3394_patch`.
- Recall legacy source kind `p3394_patch`.
- Dedicated main/renderer Patch Candidate tests and obsolete fixtures.

The generic Skill evolution patch workflow remains. Its validator is named `validateSkillPatchContent` and is not coupled to KSTAR Patch Candidates.

Generic P3394 message replay watermarks also remain, but they no longer create new files under the retired `local/kstar/` namespace. Receiver and sender watermark files now live under `local/p3394/`, with a one-time atomic move when an existing watermark is found at the old location.

## Main implementation areas

- `src/main/features/recall/`
- `src/main/features/kstar/`
- `src/main/features/cogseed_backend/recall-bridge.ts`
- `src/main/features/cognition/`
- `src/main/features/p3394/`
- `src/main/ipc/index.ts`
- `src/renderer/modules/recall-projection-card.js`
- `src/renderer/modules/skills.js`
- `src/renderer/modules/skills-bindings.js`

## Verification checklist

Fresh final-cleanup verification on `dev/remove-p3394-kstar`:

- `npm run typecheck`
- Targeted canonical KSTAR, Recall, Cognition, generic P3394 wake/epoch, IPC, renderer, and static deletion tests:
  - 20 files passed.
  - 266 tests passed.
- `git diff --check`
- Production and test reference scans confirming no remaining Patch Candidate routes, fixtures, locale keys, or UI symbols, and no active P3394 Engine/Compat/Experience/Migration/Archive paths.

The full `npm test` and `npm run smoke` commands were previously green before this final cleanup, but have not been rerun for the final uncommitted branch state. They remain part of Task 6 before integration.

## Integration note

The deletion is currently implemented in the local `dev/remove-p3394-kstar` worktree and is not yet committed or merged into local `develop`. Protected `develop` must not be pushed directly; normal remote delivery remains a `dev/*` branch and GitLab merge request.
