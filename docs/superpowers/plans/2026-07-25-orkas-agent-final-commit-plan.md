# Orkas Agent Final Commit and Workspace Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Finish the remaining Orkas Agent release work with one independent sidebar/pagination commit, one curated documentation commit, and one safe ignore/cleanup commit without altering the completed runtime boundaries.

**Architecture:** Commits F, G, C, the two G follow-ups, and D are already complete and must remain unchanged. The remaining product code is limited to renderer conversation-list pagination/project backfill/relay activity behavior and its sidebar test. Documentation and generated-artifact handling are separate concerns: docs are curated into a docs commit, while local render/cache/workflow state is ignored and cleaned only after explicit confirmation.

**Tech Stack:** Git, Electron renderer JavaScript, Vitest through `npm run test:js`, TypeScript through `npm run typecheck`, Markdown design/release evidence, `.gitignore`.

---

## Current committed baseline

```text
7dec9b6 style(group-chat): normalize TypeScript string quote formatting
 aaaf485 feat(group-chat): integrate collaboration and P3394 runtime
62f56bf feat(ipc-renderer): add collaboration and P3394 surfaces
d509024 test(group-chat): cover long-writing protocol behavior
23c7faf test(agents): cover interface contract normalization
7590403 feat(commander): migrate backend compatibility to Orkas Core
```

Do not amend or rewrite these commits. Every remaining commit must be based on `7590403` and must stage only its named boundary.

## Remaining commit boundaries

| Commit | Scope | Required? | Status |
|---|---|---:|---|
| E | Sidebar list pagination, project backfill, relay activity tracking, and `conversation-sidebar.test.ts` | Yes | Uncommitted |
| Docs | Curated specs and final release/test evidence | Optional but recommended | Untracked docs |
| Hygiene | `.gitignore` entries for local render/cache/workflow artifacts | Recommended | Not started |

The following are not pending code commits: G, C, D, and both G follow-ups are already committed.

---

### Task 1: Freeze the baseline and inventory the remaining work

**Files:**
- Read: `src/renderer/modules/conversation.js`
- Read: `test/renderer/conversation-sidebar.test.ts`
- Read: `git status --short --branch`
- Read: `git diff --unified=3 -- src/renderer/modules/conversation.js test/renderer/conversation-sidebar.test.ts`

- [ ] **Step 1: Confirm only E code is tracked as modified**

Run:

```bash
git status --short --branch
git diff --name-status
```

Expected tracked modifications before E staging:

```text
M  src/renderer/modules/conversation.js
M  test/renderer/conversation-sidebar.test.ts
```

If any other tracked source file is modified, stop and classify it before staging E.

- [ ] **Step 2: Confirm E hunk ownership**

Accept only changes that implement:

- bounded startup conversation list hydration;
- project conversation page backfill after first paint;
- request-generation protection against stale list/project responses;
- local list-generation bumps after pin, rename, delete, recovery, transfer, and new-chat mutations;
- relay/sidebar activity bump behavior required by those list updates.

Reject or leave unstaged any hunk that changes collaboration/P3394 UI, Commander settings, prompt rules, or unrelated renderer behavior.

- [ ] **Step 3: Run the pre-change focused test**

Run:

```bash
npm run test:js -- test/renderer/conversation-sidebar.test.ts
```

Expected: the existing sidebar regression tests execute against the current working tree. Record the exact pass/fail count before staging.

---

### Task 2: Stage and commit E — Sidebar/Pagination/Relay

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `test/renderer/conversation-sidebar.test.ts`

**Commit message:**

```text
feat(renderer): add sidebar pagination and relay activity tracking
```

- [ ] **Step 1: Stage only E hunks**

Use hunk-level staging:

```bash
git add -p -- src/renderer/modules/conversation.js
```

Accept the sidebar/project/relay hunk groups identified in Task 1. Leave any unrelated hunk unstaged.

Stage the matching test only after reviewing its additions:

```bash
git add -- test/renderer/conversation-sidebar.test.ts
```

- [ ] **Step 2: Review the E cached diff**

Run:

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached -- src/renderer/modules/conversation.js test/renderer/conversation-sidebar.test.ts
```

Expected review properties:

- no IPC, prompt, Commander, or P3394 protocol handler changes;
- no generated files;
- no unrelated settings changes;
- test additions cover stale response protection, project page backfill, and recently-active conversation hydration.

- [ ] **Step 3: Verify the exact staged E tree**

Create a detached worktree from `HEAD`, overlay only the cached E files, and run:

```bash
npm run typecheck -- --pretty false
npm run test:js -- test/renderer/conversation-sidebar.test.ts
```

Expected: typecheck exits 0 and the sidebar test file passes.

- [ ] **Step 4: Run the broader renderer regression set**

Run:

```bash
npm run test:js -- \
  test/renderer/conversation-sidebar.test.ts \
  test/renderer/conversation-info.test.ts \
  test/renderer/conversation-agent-status.test.ts \
  test/renderer/ipc-shim.test.ts
```

Expected: all selected files pass with no failures.

- [ ] **Step 5: Obtain per-commit approval and commit E**

Do not commit until the cached diff has been shown and approved. Then run:

```bash
git commit -m "feat(renderer): add sidebar pagination and relay activity tracking"
```

Record the resulting commit id in the final release ledger.

---

### Task 3: Curate and commit documentation evidence

**Files:**
- Candidate source: `docs/superpowers/specs/`
- Candidate evidence: `docs/superpowers/reports/`
- Candidate release plan: `docs/superpowers/plans/2026-07-25-orkas-agent-final-commit-plan.md`

**Commit message:**

```text
docs: preserve agent design and release evidence
```

- [ ] **Step 1: Select only durable documents**

Recommended durable specs:

```text
docs/superpowers/specs/2026-07-24-kstar-agent-integration-design.md
docs/superpowers/specs/2026-07-24-kstar-review-center-design.md
docs/superpowers/specs/2026-07-25-agent-activity-panel-design.md
docs/superpowers/specs/2026-07-25-collaboration-overview-drawer-design.md
docs/superpowers/specs/2026-07-25-commander-shared-context-conflicts-design.md
docs/superpowers/specs/2026-07-25-orkas-agent-protocol-layer-design.md
docs/superpowers/specs/2026-07-25-orkas-tool-kstar-evidence-design.md
```

Recommended release evidence:

```text
docs/superpowers/reports/2026-07-25-orkas-agent-preflight.md
docs/superpowers/reports/2026-07-25-orkas-agent-staging-map.md
docs/superpowers/reports/2026-07-25-orkas-agent-staging-commands.md
```

The candidate reports `2026-07-25-commit-c-candidate.md` and `2026-07-25-commit-f-candidate.md` are historical working reports. Include them only if the release record needs the intermediate boundary decisions; otherwise leave them untracked.

- [ ] **Step 2: Review docs for secrets and temporary paths**

Run:

```bash
rg -n "api[_-]?key|token|secret|oauth|/Users/|/private/|/tmp/" docs/superpowers/specs docs/superpowers/reports
```

Redact or remove any raw secret, private credential, user content, or machine-specific path before staging. Do not stage generated DOCX/PDF files in this commit.

- [ ] **Step 3: Stage only selected docs**

Use explicit paths:

```bash
git add -- \
  docs/superpowers/specs/2026-07-24-kstar-agent-integration-design.md \
  docs/superpowers/specs/2026-07-24-kstar-review-center-design.md \
  docs/superpowers/specs/2026-07-25-agent-activity-panel-design.md \
  docs/superpowers/specs/2026-07-25-collaboration-overview-drawer-design.md \
  docs/superpowers/specs/2026-07-25-commander-shared-context-conflicts-design.md \
  docs/superpowers/specs/2026-07-25-orkas-agent-protocol-layer-design.md \
  docs/superpowers/specs/2026-07-25-orkas-tool-kstar-evidence-design.md \
  docs/superpowers/reports/2026-07-25-orkas-agent-preflight.md \
  docs/superpowers/reports/2026-07-25-orkas-agent-staging-map.md \
  docs/superpowers/reports/2026-07-25-orkas-agent-staging-commands.md \
  docs/superpowers/plans/2026-07-25-orkas-agent-final-commit-plan.md
```

- [ ] **Step 4: Validate and review docs cached diff**

Run:

```bash
git diff --cached --check
git diff --cached --stat
git diff --cached
```

No code test is required for pure Markdown, but the diff must contain no secrets, generated binaries, absolute personal paths, or temporary process logs.

- [ ] **Step 5: Obtain docs commit approval and commit**

After cached diff approval:

```bash
git commit -m "docs: preserve agent design and release evidence"
```

---

### Task 4: Add ignore rules and clean local artifacts safely

**Files:**
- Modify: `.gitignore`
- Do not stage: DOCX/PDF deliverables unless explicitly requested.

**Commit message:**

```text
chore: ignore local render and workflow artifacts
```

- [ ] **Step 1: Add narrowly scoped ignore rules**

Append these rules to the existing `.gitignore`:

```gitignore
# Local document/render outputs and workflow state
/.docx_render_*/
/.pdf_render_*/
/.superpowers/
__pycache__/
*.py[cod]
```

Do not add broad patterns such as `*.docx` or `*.pdf`; user-facing P3394 deliverables must remain individually controllable.

- [ ] **Step 2: Verify ignore behavior without deleting anything**

Run:

```bash
git check-ignore -v \
  .docx_render_p3394_report/page-1.png \
  .pdf_render_p3394_template/page-1.png \
  .superpowers/brainstorm/19847-1784959078/state/server.pid \
  resources/test/__pycache__/test_social_data.cpython-312.pyc
```

Expected: each local artifact is matched by the intended rule. Confirm no tracked source file is newly ignored:

```bash
git ls-files -ci --exclude-standard
```

Expected: empty output.

- [ ] **Step 3: Review cleanup targets**

Safe cleanup candidates after approval:

```text
.docx_render_p3394_report/
.docx_render_p3394_template/
.docx_render_team2_v2/
.pdf_render_p3394_template/
.superpowers/
resources/**/__pycache__/
```

Do not delete these without a separate explicit approval:

```text
P3394_*.docx
P3394_*.pdf
.~394_*.docx
```

- [ ] **Step 4: Stage and review `.gitignore` only**

```bash
git add -- .gitignore
git diff --cached --check
git diff --cached -- .gitignore
```

Do not stage generated files just because they are now ignored.

- [ ] **Step 5: Obtain cleanup commit approval and commit**

After approval:

```bash
git commit -m "chore: ignore local render and workflow artifacts"
```

Cleanup of ignored files is a separate action and must not be combined with the commit unless explicitly approved.

---

### Task 5: Final release verification

- [ ] **Step 1: Verify commit ledger**

Run:

```bash
git log --oneline --decorate -12
git status --short --branch
```

Expected: the completed commit chain contains F, G, C, both G follow-ups, D, E, and any separately approved docs/hygiene commits.

- [ ] **Step 2: Run the full JavaScript suite**

```bash
npm run test:js
```

Expected: zero failed test files. Record skipped tests and their reasons.

- [ ] **Step 3: Run TypeScript verification**

```bash
npm run typecheck -- --pretty false
```

Expected: exit 0.

- [ ] **Step 4: Check whitespace and remaining state**

```bash
git diff --check
git diff --cached --check
git status --short --branch
```

Expected: no whitespace errors, no accidental staged files, and any remaining untracked deliverables explicitly classified as preserved documents or ignored local artifacts.

- [ ] **Step 5: Preserve evidence**

Update the final release report with exact commands, counts, skipped tests, commit ids, and cleanup decisions. Never copy secrets, raw credentials, or full user content into the report.

---

## Approval gates

1. Approve E cached diff before committing E.
2. Approve the curated docs cached diff before committing docs.
3. Approve `.gitignore` cached diff before committing hygiene.
4. Approve any deletion of ignored render/cache directories separately. The plan never authorizes deletion of user-facing DOCX/PDF deliverables by itself.

## Final success criteria

- Required code commit E is complete and independently tested.
- Selected design/evidence docs are preserved in a reviewable docs commit.
- Local generated artifacts are ignored without broad document ignores.
- No user-facing DOCX/PDF deliverable is deleted without explicit approval.
- Full `npm run test:js`, `npm run typecheck -- --pretty false`, and whitespace checks pass.
