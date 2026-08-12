# Remove Legacy P3394 KSTAR Design

Date: 2026-08-12

## Goal

Delete the legacy P3394 KSTAR system end to end while preserving the current canonical `features/kstar/` → Recall flow and the generic P3394 capabilities that are not themselves legacy KSTAR.

## Scope

Delete the legacy P3394 KSTAR implementation:

- Engine adapter, factory, snapshots, pending-evidence replay, recovery, migration, archive surfaces, and the orphaned P3394 ability-asset store.
- Compat run, Pass/Fail review, Experience Candidate, Knowledge Base promotion, and Notion sync.
- Group Chat dual-write of tool/run/contribution evidence into the P3394 Engine adapter.
- P3394 KSTAR boot initialization.
- P3394 KSTAR IPC and renderer shim routes.
- Legacy `kstar_review` message metadata and renderer cards.
- Conversation Info legacy KSTAR attention/history/migration surfaces.
- P3394 KSTAR locale keys and dedicated tests.

Keep:

- Canonical KSTAR under `src/main/features/kstar/`.
- Recall candidates, projections, assets, proofs, and effectiveness governance.
- Generic wake requests and their execution/approval lifecycle.
- Generic P3394 protocol, execution-boundary, execution observability, context reuse receipts, behavior contrast, and skill validation.
- Existing legacy files on user disks as inert data; the application stops reading, mutating, replaying, migrating, or exposing them.

## Boundary migration

The generic wake path currently imports `KStarDecisionRecord` and `KStarExpectation` from `p3394/kstar-compat.ts`. These small decision/expectation contracts are not legacy engine storage or review records; move them to canonical KSTAR ownership under `features/kstar/dispatch-decision.ts` and update wake/group-chat imports.

The canonical requirement/preload lifecycle remains the source of current KSTAR task state. This phase does not merge canonical Episode Review with Requirement PRM/AAR; it only removes the old P3394 implementation.

The generic receiver/sender epoch watermarks are not KSTAR learning state. Their files move from the retired `<uid>/local/kstar/` namespace to `<uid>/local/p3394/`; when the new file is absent, the store performs a one-time atomic rename of the old watermark file so replay protection is preserved without continuing to write new runtime state under the KSTAR directory.

## Resulting runtime flow

```text
User message
→ canonical KSTAR Requirement/Task routing
→ Recall preload projection
→ user confirmation / generic wake execution
→ canonical KSTAR Episode evidence
→ canonical Review / Requirement PRM+AAR
→ Recall Candidate
→ Ability Asset
```

No runtime path may write or read P3394 KSTAR snapshots, compat runs, Experience Candidates, or old KSTAR archives after this change.

## Deletion proof

A static deletion-proof test must enforce:

- No production files named `p3394/kstar-*` remain, except no exceptions.
- No P3394 KSTAR IPC channels or `/kstar`/`/experience` compatibility routes remain.
- No `kstar_review` legacy message field remains; `kstar_review_card` is allowed because it belongs to canonical KSTAR.
- No P3394 KSTAR locale namespaces remain.
- Canonical `features/kstar/` and Recall bridges remain present.
