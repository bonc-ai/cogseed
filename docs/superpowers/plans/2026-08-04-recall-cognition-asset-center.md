# Recall Cognition Asset Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Turn the current adapter-style cognition prototype into a Recall-style Skill Asset Center with a stable backend view model and the agreed five-tab renderer: Overview / Skills / Candidates / Reuse Receipts / Assets.

**Architecture:** Keep existing source systems authoritative: `skills`, `memory`, `personal_ontology_*`, `p3394`, and `execution-records`. Add a focused cognition domain layer that normalizes source data into stable view models; IPC remains validation-only; the renderer consumes only cognition IPC shapes. The old evolution backend was archived with the Meta Skill Engine line. Skills/Cognition retains lightweight skill version history and rollback through `src/main/features/skills/version-store.ts` and `src/main/features/skills/rollback-service.ts`.

**Tech Stack:** Electron main process TypeScript, classic renderer JavaScript/HTML/CSS, `window.cogseed.invoke`, Vitest via `npm run test:js`, full verification via `npm test`.

---

## Agreed product contract

The Skills entry opens one Recall-style Skill Asset Center with exactly these tabs:

```text
[Overview] [Skills] [Candidates] [Reuse Receipts] [Assets]
```

The Skills tab must retain the original skill-library behavior: create, import, marketplace/more, category filtering, grid, detail view, source tree, edit chat, enable/disable, use, and delete. Version history and rollback are detail-level modules, not a top-level tab. The standalone evolution-console navigation, topbar shortcut, panel, and lazy frontend bundle are removed; evolution backend code stays available to the Skills/Cognition domain.

---

## Files and responsibilities

### Backend

- Modify `src/main/features/cognition/types.ts` — define stable `CognitionAssetView`, `CognitionCandidateView`, `CognitionReceiptView`, `CognitionVersionView`, filters, dashboard, and detail result types.
- Create `src/main/features/cognition/normalize.ts` — pure normalization helpers for ids, dates, summaries, status/type labels, relation refs, and rollback capability.
- Modify `src/main/features/cognition/assets-adapter.ts` — normalize skills, memory, personal ontology groups, and supported evaluation/knowledge rows without putting business logic in IPC.
- Modify `src/main/features/cognition/candidates-adapter.ts` — normalize personal ontology, p3394 experience, and p3394 patch candidates; expose target asset refs, source refs, evidence/diff availability, and allowed actions.
- Modify `src/main/features/cognition/receipts-adapter.ts` — normalize receipt list/detail fields and robustly match skill/asset refs.
- Modify `src/main/features/cognition/dashboard.ts` — calculate Overview counts/warnings from normalized assets, candidates, and receipts.
- Modify `src/main/features/cognition/skill-summary.ts` — return selected-skill assets, current version, version history, rollback capability, pending candidates, and recent reuse receipts.
- Modify `src/main/features/cognition/index.ts` — export the domain functions only.
- Modify `src/main/features/skills/version-store.ts` — preserve content snapshots and `canRollback`; read legacy `local/kstar/versions` records as compatibility input.
- Modify `src/main/features/skills/rollback-service.ts` — keep rollback transactional at the feature level; append rollback provenance after a successful write.
- Modify `src/main/ipc/index.ts` — validate cognition filters, ids, version strings, and decision payloads; delegate to cognition/evolution features.

### Renderer

- Modify `src/renderer/index.html` — keep the five cognition tabs inside `panel-skills`; keep the original skill-library markup inside the Skills tab; remove `evolution-btn`, `topbar-evolution-toggle`, and `panel-evolution`.
- Modify `src/renderer/modules/boot.js` — remove standalone evolution panel mapping and lazy-load branch; route a persisted legacy `evolution` view to `skills` before panel selection.
- Modify `src/renderer/modules/state.js` — remove evolution sidebar/topbar bindings.
- Modify `src/renderer/modules/lazy-features.js` — remove the standalone evolution frontend bundle registration.
- Modify `src/renderer/modules/skills.js` — render the five-tab center, preserve original skill-library rendering, render asset/candidate/receipt cards from normalized models, and render skill-detail versions/rollback.
- Modify `src/renderer/modules/skills-bindings.js` — handle tab switching, receipt detail expansion, candidate decisions, personal-ontology navigation, asset navigation, and rollback errors/progress.
- Modify `src/renderer/style.css` — add shared asset-center/card/detail styles without creating duplicate button/card primitives.
- Modify `src/renderer/locales/en.json`, `zh.json`, `ja.json`, `pt.json` — add all visible labels and status text.

### Tests

- Create `test/main/features/cognition.test.ts` cases for normalized asset/candidate/receipt relationships, dashboard counts, and selected-skill summary.
- Create `test/main/ipc/cognition.test.ts` cases for all cognition list/read/decision/rollback channels and invalid payloads.
- Modify `test/main/features/evolution/versions-store.test.ts` for legacy records, content snapshots, and rollback capability.
- Modify `test/main/features/evolution/patch-service.test.ts` for apply snapshot and rollback provenance.
- Modify `test/renderer/skills-frontmatter.test.ts` and `test/renderer/skills-cognition-layout.test.ts` for the five tabs, original skill-library markup, receipt detail, asset/candidate cards, and rollback action.
- Modify `test/renderer/boot-evolution.test.ts`, `test/renderer/topbar-evolution.test.ts`, and `test/renderer/lazy-features-evolution.test.ts` to assert the standalone evolution frontend is absent.

---

## Task 1: Lock the backend view-model contract with failing tests

**Files:**
- Modify `test/main/features/cognition.test.ts`
- Modify `test/main/ipc/cognition.test.ts`
- Modify `test/main/features/evolution/versions-store.test.ts`
- Modify `test/main/features/evolution/patch-service.test.ts`

- [ ] Use this exact minimum backend contract in the tests before implementation:

```ts
interface CognitionAssetView {
  id: string;
  type: 'skill' | 'knowledge' | 'ontology' | 'evaluation';
  title: string;
  source: string;
  status?: string;
  version?: string;
  relationRefs: string[];
  reuseCount: number;
  candidateCount: number;
  updatedAt?: string;
}

interface CognitionCandidateView {
  id: string;
  source: 'personal_ontology' | 'p3394_experience' | 'p3394_patch';
  sourceId: string;
  type: 'preference' | 'ontology' | 'rule' | 'experience' | 'skill_evolution';
  title: string;
  summary: string;
  targetAssetId?: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  diffAvailable: boolean;
  actions: Array<'open_personal_ontology' | 'source' | 'accept' | 'reject'>;
}
```

- [ ] Write tests that require every asset row to contain stable `id`, `type`, `title`, `source`, `status`, `version` when known, `relationRefs`, and `updatedAt`.
- [ ] Write tests that require candidate rows to expose `source`, `sourceId`, `targetAssetId` when known, `sourceRefs`, `evidenceRefs`, `diffAvailable`, and an explicit action set; personal ontology rows must not expose an in-console accept/reject action.
- [ ] Write tests for receipt list/detail parity: list rows have summary fields and detail reads return refs, scopes, boundary, execution/session metadata, and timestamps.
- [ ] Write tests for version records: new records with `content` have `canRollback: true`; legacy records without content remain readable and have `canRollback: false`.
- [ ] Run the targeted tests and confirm they fail for the missing fields/behavior.

Run:

```bash
npm run test:js -- test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/main/features/evolution/versions-store.test.ts test/main/features/evolution/patch-service.test.ts
```

Expected: FAIL on the new contract assertions before implementation.

## Task 2: Implement normalization and backend aggregation

**Files:**
- Create `src/main/features/cognition/normalize.ts`
- Modify `src/main/features/cognition/types.ts`
- Modify `src/main/features/cognition/assets-adapter.ts`
- Modify `src/main/features/cognition/candidates-adapter.ts`
- Modify `src/main/features/cognition/receipts-adapter.ts`
- Modify `src/main/features/cognition/dashboard.ts`
- Modify `src/main/features/cognition/skill-summary.ts`
- Modify `src/main/features/cognition/index.ts`

- [ ] Implement pure normalizers that never read storage and cap user-visible summaries/ref arrays.
- [ ] Normalize asset types to `skill`, `knowledge`, `ontology`, and `evaluation`; retain source-specific ids in `sourceId` and stable display ids in `id`.
- [ ] Normalize candidate actions so `personal_ontology` maps to `open_personal_ontology`, while p3394 experience/patch rows map to `accept`, `reject`, and `source` where supported.
- [ ] Normalize receipt refs and support skill matching through explicit `skill:<id>` / `skill://<id>` refs plus the normalized target asset id.
- [ ] Make dashboard counts include all normalized assets, not only skills.
- [ ] Make selected-skill summary include version history with `canRollback`, related candidates, related assets, and recent receipts.
- [ ] Run Task 1 targeted tests and confirm they pass.

Run:

```bash
npm run test:js -- test/main/features/cognition.test.ts test/main/features/evolution/versions-store.test.ts test/main/features/evolution/patch-service.test.ts
```

## Task 3: Complete IPC contract and rollback boundary

**Files:**
- Modify `src/main/ipc/index.ts`
- Modify `src/main/features/skills/version-store.ts`
- Modify `src/main/features/skills/rollback-service.ts`
- Modify `test/main/ipc/cognition.test.ts`
- Modify `test/main/features/evolution/versions-store.test.ts`
- Modify `test/main/features/evolution/patch-service.test.ts`

- [ ] Keep IPC handlers limited to argument validation and feature calls.
- [ ] Support `cognition.dashboard.read`, candidates list/decide, receipts list/read, assets list, skill summary, and `cognition.skills.rollback`.
- [ ] Validate `skillId`, `executionId`, candidate ids, filters, and semver-like version strings at the IPC boundary.
- [ ] Reject rollback when the requested version has no content snapshot; do not silently fall back to current content.
- [ ] On successful rollback, write `SKILL.md` through the existing skill feature writer and append rollback provenance to version history.
- [ ] Run backend/IPC tests and typecheck.

Run:

```bash
npm run typecheck
npm run test:js -- test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/main/features/evolution/versions-store.test.ts test/main/features/evolution/patch-service.test.ts
```

## Task 4: Remove standalone evolution frontend without removing backend

**Files:**
- Modify `src/renderer/index.html`
- Modify `src/renderer/modules/boot.js`
- Modify `src/renderer/modules/state.js`
- Modify `src/renderer/modules/lazy-features.js`
- Modify `test/renderer/boot-evolution.test.ts`
- Modify `test/renderer/topbar-evolution.test.ts`
- Modify `test/renderer/lazy-features-evolution.test.ts`
- Create `test/renderer/evolution-console-removed.test.ts`

- [ ] Remove the sidebar and topbar entries for the standalone evolution console.
- [ ] Remove `panel-evolution` from the renderer shell and remove its lazy feature registration.
- [ ] Route a persisted legacy `evolution` view to `skills` so existing users do not land on a missing panel.
- [ ] Keep lightweight Skills/Cognition version and rollback services; do not reintroduce standalone evolution IPC.
- [ ] Run the updated renderer navigation tests and verify no standalone evolution frontend references remain.

Run:

```bash
npm run test:js -- test/renderer/evolution-console-removed.test.ts test/renderer/boot-evolution.test.ts test/renderer/topbar-evolution.test.ts test/renderer/lazy-features-evolution.test.ts
```

## Task 5: Make the Skills tab compatible with the original skill library

**Files:**
- Modify `src/renderer/index.html`
- Modify `src/renderer/modules/skills.js`
- Modify `src/renderer/modules/skills-bindings.js`
- Modify `src/renderer/style.css`
- Create/modify `test/renderer/skills-cognition-layout.test.ts`
- Modify `test/renderer/skills-frontmatter.test.ts`

- [ ] Keep exactly five tabs: `overview`, `skills`, `candidates`, `receipts`, `assets`.
- [ ] Keep the original skill-library DOM and event ids inside the Skills tab: grid header, Create, More, categories, grid, detail view, source tree, edit chat, and detail actions.
- [ ] Ensure entering the Skills tab loads/refreshes the original skill list and does not initialize a second skill renderer or duplicate click handlers.
- [ ] Render asset-center header and tabs with restrained typography, stable spacing, shared card/button classes, and no new hard-coded SVG/emoji icons.
- [ ] Keep detail-level version history and rollback in the selected skill view; do not create a Version top-level tab.
- [ ] Add tests that the five tabs exist and the original skill-library DOM remains inside the Skills tab.

Run:

```bash
npm run test:js -- test/renderer/skills-cognition-layout.test.ts test/renderer/skills-frontmatter.test.ts
```

## Task 6: Implement complete candidate, receipt, and asset views

**Files:**
- Modify `src/renderer/modules/skills.js`
- Modify `src/renderer/modules/skills-bindings.js`
- Modify `src/renderer/style.css`
- Modify `src/renderer/locales/en.json`
- Modify `src/renderer/locales/zh.json`
- Modify `src/renderer/locales/ja.json`
- Modify `src/renderer/locales/pt.json`
- Modify `test/renderer/skills-frontmatter.test.ts`
- Modify `test/renderer/skills-cognition-layout.test.ts`

- [ ] Candidates: show type, source, summary, confidence/scope, target asset, source/evidence refs, and the correct action set. Personal ontology candidates only show navigation to Personal Ontology.
- [ ] Receipts: show status, agent/session/conversation, reused/omitted refs, permission mode, allowed scopes, boundary, and completed time; support inline detail expansion with loading/error states.
- [ ] Assets: show type filter, source, status, version, relation counts, reuse counts, and correct open action for skill/ontology/knowledge assets.
- [ ] Overview: show counts, recent reuse, pending review, and degraded warnings using the normalized fields.
- [ ] Ensure all visible strings use renderer locale keys and re-render on `i18n-change`.
- [ ] Add pure renderer tests for escaping, empty states, detail expansion, and action attributes.

Run:

```bash
npm run test:js -- test/renderer/skills-cognition-layout.test.ts test/renderer/skills-frontmatter.test.ts
```

## Task 7: Full verification and review gate

**Files:**
- Review all files changed by Tasks 1-6.

- [ ] Run `git diff --check`.
- [ ] Run `npm run typecheck`.
- [ ] Run the focused backend/IPC/renderer test set.
- [ ] Run `npm test` and require zero failures.
- [ ] Manually launch with `./run.sh`, open Skills, verify the five tabs, open the original skill grid/detail, inspect a candidate, expand a receipt, inspect an asset, and confirm there is no standalone evolution navigation.
- [ ] Leave cognition/evolution changes uncommitted until the user reviews the running UI, unless the user explicitly asks for a commit.

Run:

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/main/features/evolution/versions-store.test.ts test/main/features/evolution/patch-service.test.ts test/renderer/evolution-console-removed.test.ts test/renderer/skills-cognition-layout.test.ts test/renderer/skills-frontmatter.test.ts
npm test
./run.sh
```

Expected: all commands pass; the app opens on the Skill Asset Center with the five agreed tabs and no standalone evolution console entry.
