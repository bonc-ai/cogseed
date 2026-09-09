# Discover Module: Real Data Implementation Plan

**Status:** Temporary implementation plan. Delete this file after the implementation has passed all acceptance criteria in this document.

**Owner:** Knowledge Base / Discover

**Created:** September 2, 2026

## 1. Objective

Replace every simulated card in the Knowledge Base Discover module with a real, traceable data source while keeping the three-tab product structure:

1. **Featured topics:** official curated knowledge packages, organization-curated packages, and the user's real topic groups.
2. **Public plaza:** real published packages that the current user is authorized to discover and subscribe to.
3. **External sources:** real connected Feishu, web, and team-space sources, including authorization scope, sync status, and source health.

The module must never show fabricated user data, fabricated connection state, fabricated source counts, or fabricated update times. To avoid an empty cold-start experience, the product will ship with **official built-in knowledge packages**. These are product-owned, versioned content with real manifests and source documents; they are not examples pretending to be user or community content.

This plan covers Discover only. It does not change Notes behavior or alter the existing Knowledge Base question-answering contract. All imported or synced content must use the existing Knowledge Base context and indexing pipeline.

## 2. Existing Assets To Reuse

The implementation must build on existing contracts instead of creating parallel data paths.

- `contexts.tree`: real user-owned context files.
- `kb.status` and `kb.reconcile`: vector-index status and disk/database reconciliation.
- `spaces.list`: real workspace and shared-space records.
- `kb.share.list`: existing Feishu knowledge-base share records.
- `kb.share.cogseed.list`: existing CogSeed Share publication records.
- Personal Context Feishu provider: OAuth, read scopes, resource listing, normalization, and sync scheduling already exist under `src/main/features/personal_context/`.

The new implementation must not read user files directly in the Renderer. Renderer access remains exclusively through `window.cogseed.invoke` and canonical IPC channels.

## 3. Product Rules

### 3.1 Data truth rules

- A card is shown as **connected** only when a persisted, currently authorized connection exists.
- Counts, update times, file names, and sync state come from source metadata or generated indexes. No hard-coded display values.
- An unavailable or expired connection remains visible with an honest status and recovery action; it must not become a successful-looking card.
- A catalog item is visible only when its visibility policy permits the current user to see it.
- Importing a package must create real user-owned context files or a controlled synced source, then enqueue the existing KB indexing flow.

### 3.2 Cold-start rules

The empty state must be informative without fake data:

- **Featured topics:** official built-in knowledge packages are always available from the packaged catalog manifest.
- **Public plaza:** show official and organization-visible packages. If no remote public catalog is configured, clearly label the available official packages; do not invent community publications.
- **External sources:** show available connection providers with `not_connected` state, plus clear source-scoped actions. A provider card is a real capability, not a fake connected source.

### 3.3 Permission rules

Creating, expanding, or syncing an external source must use the action-approval system where an authorization decision is required. The approval card must state:

- execution subject and provider;
- selected document, folder, Wiki, URL, or team space;
- read-only scope, sync frequency, and retention behavior;
- authorization expiration or revocation behavior;
- user options to approve or reject.

Approval must be scoped to the selected resource. The system must not request broad account-wide access when a narrower resource scope is available.

## 4. Target Architecture

### 4.1 Renderer

`src/renderer/modules/kb-discover.js` becomes a thin view layer. It must render normalized Discover view models and hold only transient UI state such as tab, query, filters, and loading state.

Remove the current hard-coded `_catalog` demo data. The Renderer receives data through these new IPC routes:

```text
kb.discover.catalog.list
kb.discover.catalog.get
kb.discover.subscription.list
kb.discover.subscription.set
kb.discover.package.import
kb.discover.sources.list
kb.discover.sources.get
kb.discover.sources.connect
kb.discover.sources.sync
kb.discover.sources.disconnect
```

Existing `contexts.tree`, `kb.status`, `spaces.list`, and share-list routes remain inputs for real user-owned topics and existing publication records.

### 4.2 Main feature boundary

Add a focused feature namespace under:

```text
src/main/features/kb_discovery/
```

Suggested modules:

```text
catalog.ts          catalog aggregation, visibility filtering, sorting
packages.ts         built-in package manifests and import orchestration
subscriptions.ts    user subscription state and package version tracking
sources.ts          external source registration, state aggregation, sync orchestration
types.ts            shared, serializable Discover view-model contracts
```

IPC handlers validate input and call this feature namespace. They must not contain catalog, permission, sync, or file-import business logic.

### 4.3 Storage ownership

User-visible preferences and syncable subscription records belong in the user's cloud data root. Machine-local cursors, fetch caches, temporary snapshots, and derived indexes belong in the local root.

Proposed records:

```text
cloud/discover/subscriptions.json
cloud/discover/sources.json
local/discover/source-cursors.json
local/discover/catalog-cache.json
local/discover/package-imports.json
```

Source tokens and connector transport secrets remain in their existing encrypted connector/OAuth stores. Discover records may contain only opaque provider instance IDs and selected resource IDs, never access tokens.

## 5. Canonical Data Models

### 5.1 Catalog item

```ts
type DiscoverCatalogItem = {
  id: string;
  kind: 'official' | 'organization' | 'public';
  visibility: 'official' | 'organization' | 'public' | 'restricted';
  title: string;
  description: string;
  tags: string[];
  publisher: { id: string; name: string; verified: boolean };
  version: string;
  updatedAt: string;
  sourceCount: number;
  importMode: 'copy' | 'reference' | 'subscription';
  permission: 'available' | 'requires_join' | 'denied';
  subscription?: { state: 'none' | 'saved' | 'subscribed'; lastSyncedAt?: string };
};
```

### 5.2 Knowledge package manifest

An official or published package needs a versioned manifest with immutable source entries, attribution, content license, content digest, and import policy. The package is real only when every listed source resolves to an approved artifact or an authorized remote reference.

```ts
type KnowledgePackageManifest = {
  packageId: string;
  version: string;
  title: string;
  visibility: 'official' | 'organization' | 'public';
  attribution: string;
  license: string;
  entries: Array<{
    sourceId: string;
    type: 'document' | 'web_snapshot' | 'team_space_reference';
    digest: string;
    importable: boolean;
  }>;
};
```

### 5.3 External source

```ts
type DiscoverSource = {
  id: string;
  provider: 'feishu' | 'web' | 'team_space';
  providerInstanceId?: string;
  title: string;
  scopeLabel: string;
  selectedResources: Array<{ id: string; type: string; name: string }>;
  authorization: 'not_connected' | 'active' | 'expired' | 'revoked';
  sync: {
    state: 'idle' | 'syncing' | 'error' | 'paused';
    lastSuccessAt?: string;
    nextRunAt?: string;
    indexedSourceCount: number;
    errorCode?: string;
  };
};
```

## 6. Tab-by-Tab Implementation

### 6.1 Featured topics

**Real inputs**

- official built-in package catalog;
- organization-curated packages when available;
- current user's real top-level Knowledge Base topic groups from `contexts.tree` and `kb.status`.

**Official built-in package delivery**

1. Add a packaged resource directory outside the user data tree, for example `resources/discovery_catalog/`.
2. Include a signed/versioned manifest and the real source files or immutable source references for each official package.
3. Expose official package metadata through `kb_discovery/packages.ts`.
4. When a user imports a package, copy authorized package files into a dedicated user context location such as `contexts/official/<package-id>/` using the existing context-storage path choke points.
5. Enqueue `kb.reconcile` or the existing indexer workflow; show import and indexing state in the card.

**Important behavior**

- A package can be browsed without being indexed into the user's KB.
- Import must be explicit. The app must not silently ingest a package merely because it is displayed.
- Package updates create a visible update state; user chooses whether to pull the new version.

### 6.2 Public plaza

**Phase-one definition:** an authorized discovery directory, not an unmoderated Internet-wide publishing system.

The initial plaza contains:

- official packages;
- organization-visible packages;
- real CogSeed Share publications that have opted into catalog discovery.

Current CogSeed Share publication supports publishing and policy synchronization, but it does not yet provide a global discoverable directory. Add a remote catalog contract that returns only records the current user can see. The Electron main process calls this remote service through a feature-owned client; the Renderer never calls the service directly.

Required remote operations:

```text
list catalog items with visibility filtering and cursor pagination
fetch package detail and current version
publish/unpublish catalog listing metadata
subscribe/unsubscribe current user
list updates since a version or timestamp
```

**Deferred from phase one**

- anonymous public uploads;
- unrestricted third-party crawling;
- automatic redistribution of copyrighted material;
- algorithmic recommendation based on private user document content.

These require separate content governance, abuse response, and privacy review.

### 6.3 External sources

#### Feishu

The project already has the strongest foundation here: OAuth, read scopes, drive file listing, Wiki listing, resource normalization, and a sync scheduler.

Implementation work:

1. Reuse the existing personal-context authorization flow; do not create a second OAuth/token store.
2. Add a Discover source-selection flow where the user chooses specific Feishu documents, folders, or Wiki spaces.
3. Persist the selected source IDs and least-privilege scope in `cloud/discover/sources.json`.
4. Materialize authorized content snapshots into a controlled connected-source directory under the user's context root.
5. Reuse the KB indexer for extraction, chunking, embeddings, deletion reconciliation, and error reporting.
6. Use the existing provider cursor/scheduler for incremental changes where possible; store Discover-specific mapping and cursor metadata locally.

#### Team spaces

Phase one uses existing `spaces.list`, Feishu share records, and CogSeed Share records. It shows only spaces that actually exist for the current user.

For cross-user or organization-wide spaces, the catalog service must resolve membership and permission before returning metadata or allowing import. A public listing never grants access to a private underlying document.

#### Web sources

Deliver in two steps:

1. **Manual capture / managed feeds:** explicit URL capture, RSS/Atom feeds, and approved site lists. Store a dated content snapshot, canonical URL, extraction result, and content digest.
2. **Continuous monitoring:** scheduled refresh, change detection, failure/retry handling, and page access-policy review.

Do not begin with broad crawling. Pages requiring login, user interaction, payment, or rights-sensitive reuse require an explicit policy before they can be continuously synced.

## 7. Implementation Sequence

### Phase 0: Replace the prototype contract

- Remove hard-coded Discover catalog cards.
- Add serializable Discover types, main feature modules, IPC validation, and renderer loading/error states.
- Keep the current real local-topic and shared-record rendering paths working.

**Exit:** Discover makes no product decision from renderer-local catalog arrays.

### Phase 1: Official built-in knowledge packages

- Create manifest format and packaged official content directory.
- Add catalog listing, package detail, explicit import, update detection, and subscription storage.
- Add real status states: available, importing, indexing, ready, update available, import failed.

**Exit:** a fresh installation renders real official packages, and importing one produces real user KB sources searchable by existing KB workflows.

### Phase 2: Feishu and existing team-space sources

- Reuse personal-context Feishu authorization.
- Add source selector, least-privilege approval, real source cards, manual sync, and incremental sync status.
- Aggregate existing shared spaces and published knowledge bases into real Discover source rows.

**Exit:** a user can select an authorized Feishu resource, sync it, see truthful source health, and search resulting content from the Knowledge Base.

### Phase 3: Organization public plaza

- Add the remote catalog client and visibility-aware catalog API.
- Allow eligible CogSeed Share publications to opt into organization discovery.
- Add real search, cursor pagination, subscription, version update, and withdrawal behavior.

**Exit:** different users see only catalog records they are authorized to discover; subscription and withdrawal update the UI without fabricated state.

### Phase 4: Web source MVP

- Add explicit URL and feed source registration.
- Add content snapshots, source attribution, refresh states, and deletion handling.
- Apply action approval before the first capture and before broadening a source's scope.

**Exit:** a user can add a permitted URL/feed, inspect its real sync result, and remove it with its imported/indexed material handled predictably.

### Phase 5: Production hardening

- package integrity/digest validation;
- catalog cache with stale-while-revalidate behavior;
- telemetry limited to IDs, states, counts, and durations;
- audit entries for authorization, import, subscription, publication, withdrawal, and source sync;
- pagination, rate limiting, retry/backoff, and failure recovery;
- documentation and user-facing empty/error states.

## 8. Acceptance Criteria

### Data integrity

- No Discover card relies on hard-coded mock content, counts, timestamps, connection state, or user identity.
- Every visible user source can be traced to a persisted source record and selected resource scope.
- Every imported package results in real context records and uses the existing KB index pipeline.
- Deleting, revoking, or losing access to a source updates Discover truthfully and prevents future sync.

### Cold start

- A clean installation shows at least one official built-in package with a real manifest and readable source metadata.
- The public plaza does not look empty when the remote catalog has no organization records; it shows the available official package set with its true origin.
- External sources show connectable provider states without presenting them as connected.

### Permissions

- Feishu, web, and team-space source setup requests only the selected read scope.
- User rejection prevents source registration and sync.
- Approval, authorization state, sync runs, failures, and revocation are auditable.

### Renderer behavior

- Search and filtering use server-provided catalog data or a clearly bounded local cache, never client-side demo records.
- Loading, stale, empty, permission-denied, expired-auth, and sync-error states are distinguishable.
- The three tabs remain responsive on desktop and mobile, including long titles and empty source lists.

## 9. Verification Plan

- Unit tests for package manifest validation, visibility filtering, subscription state, import idempotency, source-scope validation, and removal/revocation paths.
- IPC contract tests for every Discover channel and validation failure.
- Feature tests for Feishu source setup using fake provider responses, including expired authorization and deleted remote documents.
- Renderer tests for all three tabs: cold start, populated state, no-access state, sync-in-progress, failed sync, and update-available state.
- Full application verification after each phase using a clean user profile and a profile with real imported/local/shared sources.
- Screenshot verification on desktop and mobile after the Renderer work is complete.

## 10. Temporary Document Deletion Rule

Do **not** delete this document during partial implementation.

Delete `docs/design/kb-discover-real-data-implementation-plan.md` only after all of the following are true:

1. Phases 0 through 4 are implemented or deliberately re-scoped with the user.
2. The acceptance criteria for the shipped scope have passed.
3. The mock catalog in `kb-discover.js` has been removed.
4. Official built-in packages and at least one external-source path are verified with real data.
5. The user has reviewed the completed Discover module implementation.

The deletion is part of the final implementation cleanup, not a substitute for documenting the shipped contracts in source, tests, or durable product documentation.
