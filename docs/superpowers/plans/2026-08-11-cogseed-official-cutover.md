# CogSeed Official Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to execute this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax and must be updated as work progresses.

**Goal:** Make CogSeed the official repository/product identity, publish PRD- and code-accurate README documentation, preserve one-cycle Mate/CogSeed compatibility, and prepare an exact `main` mirror of the verified `develop` release.

**Architecture:** Treat `src/resources/identity.json` and `src/main/brand.ts` as the canonical identity sources. Update only current/public surfaces to CogSeed, while keeping legacy aliases in explicit migration, protocol-normalization, wrapper, fixture, and historical-document boundaries. The implementation branch lands through an MR into `develop`; release operations then archive the old `main`, mirror the final `develop` SHA to `main`, and rename the GitLab project path.

**Tech Stack:** Electron, Node.js/CommonJS bootstrap, TypeScript main process, classic renderer JavaScript, JSON metadata, Vitest, Python resource tests, GitLab protected-branch workflow.

---

### Task 1: Establish the cutover branch baseline and residual-name contract

**Files:**
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/test/main/cogseed-residual-identifiers.test.ts`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/test/main/identity-contract.test.ts`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/test/main/brand.test.ts`
- Test: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/test/main/runtime-variant.test.ts`

- [ ] **Step 1: Record the source and release SHAs without changing remote refs**

Run:

```bash
git fetch origin develop main
git rev-parse origin/develop origin/main
```

Expected: `origin/develop` is the MR !32 merge tip; `origin/main` is the old release tip. Do not force-push or rename the project in this task until all local checks pass.

- [ ] **Step 2: Add failing assertions for current-vs-legacy naming boundaries**

Add tests that assert:

```ts
expect(identity.IDENTITY.runtimeVariant).toBe('cogseed');
expect(identity.IDENTITY.legacyRuntimeVariants).toEqual(['cogseed']);
expect(protocolSchemes()).toEqual(['cogseed', 'cogseed', 'cogseed']);
expect(read('package.json')).toContain('"name": "cogseed"');
```

Add a residual scan helper that fails on `Mate Agent`, `CogSeedAgent`, `cogseed-agent`, or current `CogSeed` branding outside the explicit allowlist of compatibility/historical files.

- [ ] **Step 3: Run the focused tests and verify the expected failures**

Run:

```bash
npm run test:js -- test/main/cogseed-residual-identifiers.test.ts test/main/identity-contract.test.ts test/main/brand.test.ts test/main/runtime-variant.test.ts
```

Expected: the package-name and residual-public-surface assertions fail before implementation; existing legacy protocol assertions remain green.

- [ ] **Step 4: Commit the test contract**

```bash
git add test/main/cogseed-residual-identifiers.test.ts test/main/identity-contract.test.ts test/main/brand.test.ts test/main/runtime-variant.test.ts
git commit -m "test: define CogSeed official naming boundaries"
```

### Task 2: Update package, repository, and public product metadata

**Files:**
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/package.json`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/package-lock.json`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/src/resources/brand.json`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/src/resources/identity.json`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/src/main/brand.ts`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/src/main/identity-contract.cjs`

- [ ] **Step 1: Change package metadata to CogSeed**

Set the root package metadata to:

```json
{
  "name": "cogseed",
  "description": "CogSeed desktop — personal cognition asset workspace"
}
```

Keep `cogseedSourceRuntimeVariant` as `cogseed` and preserve the package imports/build metadata already aligned with the current Electron app.

- [ ] **Step 2: Regenerate only the package-lock root identity**

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` root package name changes to `cogseed`; dependency versions and lockfile integrity remain unchanged.

- [ ] **Step 3: Verify canonical and legacy identity metadata**

Keep these canonical values:

```json
{
  "appName": "CogSeed",
  "appId": "com.cogseed.desktop",
  "protocolScheme": "cogseed",
  "dataRootName": ".cogseed",
  "runtimeVariant": "cogseed"
}
```

Keep the one-cycle compatibility arrays:

```json
{
  "legacyProtocolSchemes": ["cogseed", "cogseed"],
  "legacyDataRootNames": [".cogseed"],
  "legacyRuntimeVariants": ["cogseed"]
}
```

- [ ] **Step 4: Run metadata tests**

Run:

```bash
npm run test:js -- test/main/identity-contract.test.ts test/main/brand.test.ts test/main/runtime-variant.test.ts test/main/util/source-branding.test.ts
```

Expected: all pass with package and identity values aligned.

- [ ] **Step 5: Commit metadata changes**

```bash
git add package.json package-lock.json src/resources/brand.json src/resources/identity.json src/main/brand.ts src/main/identity-contract.cjs
git commit -m "refactor: make CogSeed the official package identity"
```

### Task 3: Rewrite README and repository-facing documentation from PRD and code

**Files:**
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/README.md`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/README.zh-CN.md`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/README-源码包说明.txt`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/目录说明.md`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/docs/README.md`
- Reference: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/AGENTS.md`
- Reference: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/docs/superpowers/specs/2026-08-10-cogseed-full-identity-migration-design.md`
- Reference: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/docs/superpowers/specs/2026-08-10-cogseed-brand-cognition-navigation-design.md`
- Reference: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/docs/superpowers/specs/2026-08-09-recall-prd-information-architecture-design.md`

- [ ] **Step 1: Write a README content fixture before rewriting prose**

Add or extend a renderer-independent test that reads the README files and asserts these exact claims are present:

```ts
expect(read('README.md')).toContain('CogSeed');
expect(read('README.md')).toContain('/team-02/cogseed.git');
expect(read('README.md')).toContain('window.cogseed');
expect(read('README.md')).toContain('npm test');
expect(read('README.md')).toContain('CC Switch');
expect(read('README.md')).toContain('.cogseed');
expect(read('README.md')).toContain('cogseed'); // compatibility section only
```

- [ ] **Step 2: Rewrite `README.md` as the canonical project overview**

Use the approved sections from the design spec: overview, capabilities, architecture, quick start, data/privacy, development workflow, migration compatibility, license/attribution. The clone command must use:

```bash
git clone http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cogseed.git
cd cogseed
./run.sh
```

Describe only behavior verified in code: Electron main process, vanilla renderer, `window.cogseed` IPC, Core Agent, CogSeed Runtime worker, local CLI agents, connectors, Cognition/Recall assets, KSTAR proofs, Personal Ontology, CC Switch import, and local data boundaries.

- [ ] **Step 3: Synchronize Chinese and repository notes**

Update `README.zh-CN.md`, `README-源码包说明.txt`, `目录说明.md`, and `docs/README.md` so current product names, clone paths, startup commands, data roots, and test commands agree with `README.md`. Keep old names only where explicitly describing migration or historical source material.

- [ ] **Step 4: Run documentation assertions**

Run:

```bash
npm run test:js -- test/main/cogseed-residual-identifiers.test.ts test/main/util/source-branding.test.ts
```

Expected: README claims pass and no unallowlisted current branding remains.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md README.zh-CN.md README-源码包说明.txt 目录说明.md docs/README.md test/main/cogseed-residual-identifiers.test.ts
git commit -m "docs: publish the CogSeed project README"
```

### Task 4: Clean current public branding while preserving compatibility wrappers

**Files:**
- Modify: exact files returned by `git grep -I -l 'Mate Agent\|CogSeedAgent\|cogseed-agent' -- ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/bin/cogseed-bridge.cjs`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/bin/cogseed-runtime-worker.cjs`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/scripts/restart-cogseed.sh`
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/test/main/cogseed-residual-identifiers.test.ts`

- [ ] **Step 1: Classify every residual old-name occurrence**

Run:

```bash
git grep -n -I -E 'Mate Agent|CogSeedAgent|cogseed-agent|\bCogSeed\b|\bCOGSEED\b' -- ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
```

Classify each occurrence as `current-public`, `compatibility`, `historical`, or `fixture`. Do not replace a compatibility/historical occurrence mechanically.

- [ ] **Step 2: Update current/public occurrences**

Replace current product labels, user-visible text, current launcher messages, repository links, and package-facing comments with CogSeed. For environment/data/protocol compatibility code, retain the old token and add a comment explaining the one-cycle compatibility purpose.

- [ ] **Step 3: Mark wrappers as deprecated**

Add a header to the old wrapper files:

```js
// Legacy compatibility alias for one CogSeed release cycle.
// New code must use the canonical CogSeed entrypoint.
```

Do not remove or change the wrapper protocol behavior in this cutover.

- [ ] **Step 4: Add the allowlist test**

The residual test must fail for an old name in a current README, package metadata, launcher message, or user-visible renderer string, while allowing the explicit compatibility paths and historical docs listed in the design spec.

- [ ] **Step 5: Run residual and static boundary tests**

Run:

```bash
npm run test:js -- test/main/cogseed-residual-identifiers.test.ts test/main/identity-contract.test.ts test/main/cogseed-protocol.test.ts test/main/util/runtime-launcher.test.ts test/main/util/source-runtime-bundle.test.ts
```

Expected: current public surfaces are CogSeed; legacy aliases remain functional.

- [ ] **Step 6: Commit branding cleanup**

```bash
git add bin src scripts test/main/cogseed-residual-identifiers.test.ts
git commit -m "refactor: finish CogSeed public branding cutover"
```

### Task 5: Full local verification and MR preparation

**Files:**
- Modify: `/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-official-cutover/docs/superpowers/plans/2026-08-11-cogseed-official-cutover.md` only if execution notes are required

- [ ] **Step 1: Run type checking and the complete test suite**

Run:

```bash
npm run typecheck
npm test
```

Expected: zero failures. Record exact file/test/resource counts in the MR description.

- [ ] **Step 2: Run the source runtime verification**

Run:

```bash
scripts/restart-cogseed.sh
ps -Ao pid,lstart,command | grep -- '--cogseed-runtime-variant=cogseed' | grep -v grep
```

Inspect:

```bash
tail -100 "$HOME/.cogseed/runtime-variants/cogseed/data/logs/$(date +%Y-%m-%d).log"
```

Expected: app root is the cutover worktree, `cogseed` is the protocol owner, renderer boot completes, and legacy protocols register as compatibility aliases.

- [ ] **Step 3: Verify README and package URL claims**

Run:

```bash
git grep -n 'cogseed-agent.git\|github.com/CogSeed-AI/CogSeed\|cd cogseed-agent\|name": "cogseed"' -- README* README-源码包说明.txt 目录说明.md docs package.json package-lock.json || true
```

Expected: no current README/package clone or package-name claim points to the old repository.

- [ ] **Step 4: Commit any verification-only updates**

```bash
git status --short --branch
git log --oneline -5
```

Expected: only intended source/spec/README commits are present and the worktree is clean.

- [ ] **Step 5: Push the cutover branch and create the MR**

```bash
git push origin HEAD:refs/heads/dev/cogseed-official-cutover \
  -o merge_request.create \
  -o merge_request.target=develop \
  -o merge_request.title='Make CogSeed the official repository identity' \
  -o merge_request.description='Updates public branding, README documentation, and repository-facing metadata while retaining one-cycle legacy compatibility.'
```

Expected: GitLab creates an MR targeting `develop`; do not push `develop` directly.

### Task 6: Merge to develop, archive old main, mirror main, and rename the GitLab project

**Files:**
- Remote GitLab repository settings and refs only; no source files

- [ ] **Step 1: Confirm the cutover MR is merged**

Run:

```bash
git fetch origin develop main
git merge-base --is-ancestor origin/dev/cogseed-official-cutover origin/develop
```

Expected: exit code `0`.

- [ ] **Step 2: Re-run the final verification against exact remote develop**

Use a clean worktree checked out at `origin/develop` and run:

```bash
npm run typecheck
npm test
```

Expected: all tests pass against the exact commit that will become `main`.

- [ ] **Step 3: Archive the old main tip**

Capture the old SHA and create the archive branch:

```bash
old_main_sha="$(git rev-parse origin/main)"
git push origin "$old_main_sha:refs/heads/archive/pre-cogseed-main-2026-08-11"
```

Expected: archive branch points to the old main SHA before any main update.

- [ ] **Step 4: Mirror develop to main with a lease**

```bash
develop_sha="$(git rev-parse origin/develop)"
git push origin "$develop_sha:refs/heads/main" \
  --force-with-lease="refs/heads/main:$old_main_sha"
```

Expected: update succeeds only if main is still at the observed old SHA. If rejected, stop and re-fetch; never replace with plain `--force`.

- [ ] **Step 5: Rename the GitLab project**

Use the GitLab project settings/API to change:

```text
name: CogSeed
path: cogseed
```

If the API/permissions are unavailable, stop after the protected-ref operation and report the exact manual GitLab action instead of pretending the rename completed.

- [ ] **Step 6: Verify the renamed remote and exact main mirror**

```bash
git remote set-url origin http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cogseed.git
git fetch origin develop main
test "$(git rev-parse origin/develop)" = "$(git rev-parse origin/main)"
git diff --exit-code origin/develop origin/main
git remote -v
```

Expected: new repository URL fetches successfully and `main` exactly matches `develop`.

- [ ] **Step 7: Commit no source changes for remote-only operations**

Remote ref and project-path operations must be recorded in the release/MR description, not as fake local commits.

## Commit Order

1. `test: define CogSeed official naming boundaries`
2. `refactor: make CogSeed the official package identity`
3. `docs: publish the CogSeed project README`
4. `refactor: finish CogSeed public branding cutover`
5. GitLab MR merge into `develop`
6. Remote archive and lease-protected `main` mirror
7. GitLab project rename to `CogSeed` / `cogseed`

## Verification Summary

The implementation is complete only when:

- the cutover MR is in `develop`;
- `npm run typecheck` and `npm test` pass on the exact release commit;
- legacy compatibility tests remain green;
- the old main SHA is archived;
- `origin/main` and `origin/develop` are identical;
- GitLab project name/path are `CogSeed` / `cogseed`;
- the new clone URL works;
- the source runtime boots as CogSeed;
- the final worktree is clean.
