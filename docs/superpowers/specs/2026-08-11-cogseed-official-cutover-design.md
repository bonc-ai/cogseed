# CogSeed Official Cutover Design

**Date:** 2026-08-11  
**Implementation branch:** `dev/cogseed-official-cutover`  
**Target development branch:** `develop`  
**Final release branch:** `main`

## 1. Objective

Complete the public and repository-level cutover from Mate Agent / Orkas naming to **CogSeed**, publish a README grounded in the current PRDs and implementation, and make GitLab `main` an exact mirror of the fully verified `develop` branch.

The cutover has four externally visible outcomes:

1. CogSeed is the only current product and repository name.
2. The canonical GitLab project path becomes `team-02/cogseed`.
3. Root documentation describes the actual CogSeed product and architecture rather than inherited Orkas marketing copy.
4. Remote `main` points to the exact same commit as the final remote `develop`.

Legacy Mate/Orkas runtime inputs remain supported for one release cycle as deprecated compatibility aliases. They are not current product identities and must not be used by new code or generated documentation.

## 2. Confirmed Decisions

- `develop` is the authoritative source for the cutover.
- MR !32, the CogSeed full identity migration, is already merged into remote `develop` at `d394c09`.
- The old remote `main` contains 17 commits that are not in `develop`; they will **not** be merged into the new release line.
- Before replacing `main`, preserve its old tip in `archive/pre-cogseed-main-2026-08-11`.
- `main` will be replaced with `develop` using a lease-protected force update, so both remote refs resolve to the same commit.
- GitLab project display name becomes `CogSeed`; project path becomes `cogseed`.
- The old GitLab path `mate-agent` may redirect temporarily if GitLab provides a redirect, but no checked-in current documentation may depend on that redirect.
- Legacy compatibility remains for one release cycle:
  - `mateagent://` and `orkas://` deep links
  - `ORKAS_*` environment variables
  - `.orkas` and `.orkas-dev` data-root migration
  - `mate` runtime variant normalization
  - `bin/orkas-bridge.cjs`
  - `bin/mate-runtime-worker.cjs`
- Historical specs, migration fixtures, compatibility tests, and source-attribution text retain old names when those names are semantically required.

## 3. Branch and Release Topology

Implementation follows the protected-branch workflow:

```text
origin/develop
    │
    └── dev/cogseed-official-cutover
            │
            └── GitLab MR → develop
                              │
                              ├── archive old main tip
                              │
                              └── force-with-lease develop SHA → main
```

The cutover branch must never push directly to `develop`. Documentation and branding changes land through a GitLab MR.

After the MR is merged, the release synchronization operation is allowed to update `main` because the user explicitly selected exact mirroring. The update must use `--force-with-lease` tied to the previously observed old `main` SHA. A plain `--force` is prohibited.

Release invariants:

```bash
git rev-parse origin/develop
git rev-parse origin/main
git diff --exit-code origin/develop origin/main
```

The first two commands must produce the same SHA and the diff must be empty.

## 4. Public Product Identity

The canonical current identity is:

| Surface | Canonical value |
|---|---|
| Product name | `CogSeed` |
| GitLab display name | `CogSeed` |
| GitLab path | `cogseed` |
| npm package name | `cogseed` |
| Electron product name | `CogSeed` |
| App ID | `com.cogseed.desktop` |
| Canonical protocol | `cogseed://` |
| Canonical data root | `.cogseed` |
| Canonical environment prefix | `COGSEED_` |
| Source runtime variant | `cogseed` |

Current public or generated surfaces must not present `Mate Agent`, `MateAgent`, `mate-agent`, or `Orkas` as the product name. The rename includes:

- root README files and clone commands
- package name and package-lock root package metadata
- repository-facing source-package documentation
- current architecture and contributor documentation
- user-visible app copy and metadata
- current build/package output names
- current launcher messages
- current repository URLs

The rename does **not** mechanically replace historical or compatibility terms. A residual-name gate must distinguish allowed legacy usage from accidental current branding.

## 5. Legacy Compatibility Policy

Compatibility identifiers are transitional adapters, not alternate product brands.

### 5.1 Allowed compatibility locations

Old names may remain only in clearly bounded locations:

- `src/resources/identity.json` legacy arrays
- identity/deep-link normalizers
- `.orkas` data migration code
- deprecated wrapper entrypoints
- compatibility fixtures and tests
- historical migration/design documents
- source attribution that accurately names the upstream project

### 5.2 Required annotations

Compatibility wrapper headers and nearby comments must state:

```text
Legacy compatibility alias. Deprecated after the CogSeed cutover release cycle.
New code must use the CogSeed canonical entrypoint.
```

### 5.3 Prohibited usage

New code must not:

- create new `ORKAS_*` settings when a `COGSEED_*` equivalent exists
- generate `mateagent://` or `orkas://` URLs
- create new `.orkas` storage paths
- launch the `mate` variant
- import deprecated wrapper entrypoints directly
- describe the current product as Mate Agent or Orkas

## 6. README Information Architecture

`README.md` becomes the canonical project README. It is written from the current CogSeed PRDs, current architecture constraints, and verified code behavior.

### 6.1 Required sections

1. **CogSeed overview**
   - A local-first multi-agent collaboration workspace.
   - A cross-agent personal capability asset layer.
   - Commander, Agents, Skills, Connectors, Cognition Assets, and Personal Ontology.

2. **Core capabilities**
   - Commander orchestration and structured dispatch.
   - Multi-agent collaboration with visibility slices and shared plans.
   - Local CLI agents: Claude Code, Codex, OpenCode, OpenClaw, and Hermes where installed.
   - Cognition Assets / Recall governance lifecycle.
   - KSTAR review, Transfer Proof, and Effectiveness Proof.
   - Personal Ontology and local knowledge-base retrieval.
   - Messaging and connector integrations.
   - CC Switch credential import.

3. **Architecture**
   - Electron main process as the Node backend.
   - Vanilla HTML/CSS/JS renderer.
   - `window.cogseed.{invoke,stream}` contextBridge API.
   - IPC as the application communication boundary.
   - In-process Core Agent and isolated CogSeed Runtime worker.
   - Approved child-process choke points for CLI agents and MCP connectors.

4. **Quick start**
   - New clone URL ending in `/cogseed.git`.
   - Node and Python requirements.
   - `./run.sh` and `run.cmd`.
   - Model authorization and optional CC Switch import.

5. **Data and privacy**
   - Canonical `.cogseed` data root.
   - User-scoped `cloud/` and `local/` domains.
   - Local encrypted secret storage.
   - No local HTTP server.
   - Direct model-provider calls using user-selected credentials.

6. **Development workflow**
   - `npm run typecheck`.
   - `npm test` rather than direct Vitest commands.
   - macOS and Windows as primary platforms.
   - MR workflow into protected `develop`.

7. **Migration compatibility**
   - Old `.orkas` data is copied and verified into `.cogseed`.
   - Old protocols and environment variables are accepted temporarily.
   - New output always uses CogSeed identifiers.

8. **License and attribution**
   - MIT license.
   - Accurate attribution of inherited/upstream work without treating the upstream name as the current product.

### 6.2 Bilingual documentation

- `README.md` is the canonical English-first or concise bilingual overview.
- `README.zh-CN.md` is updated to match the same facts and section structure.
- Neither README may contain conflicting data-root, clone URL, runtime, or branding claims.
- `README-源码包说明.txt` and `目录说明.md` must use current CogSeed naming where they describe the current project.

## 7. Repository Rename Procedure

Repository rename is performed only after the cutover MR is merged and verified on `develop`.

1. Record project identity and current URLs.
2. Change GitLab project display name to `CogSeed`.
3. Change GitLab project path to `cogseed`.
4. Update the local remote URL:

```bash
git remote set-url origin http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cogseed.git
```

5. Run `git fetch origin develop main` using the new URL.
6. Confirm repository branches, MR history, and tags remain accessible.
7. Search checked-in files for the old repository URL.
8. Confirm the old GitLab URL either redirects or fails in the expected controlled manner; the new URL is authoritative regardless.

If CLI/API permission is unavailable, repository rename must stop with a precise manual action request. Code and README changes may still be merged, but `main` mirroring must not proceed under a stale repository identity unless the user explicitly accepts that temporary state.

## 8. Main Branch Exact Mirroring

Before replacing `main`:

1. Fetch `origin/develop` and `origin/main`.
2. Verify the cutover MR is in `origin/develop`.
3. Verify all required tests against the exact `origin/develop` commit.
4. Create the archive branch at the observed old main SHA:

```bash
git push origin <old-main-sha>:refs/heads/archive/pre-cogseed-main-2026-08-11
```

5. Replace `main` using the observed old SHA as the lease:

```bash
git push origin <develop-sha>:refs/heads/main \
  --force-with-lease=refs/heads/main:<old-main-sha>
```

6. Fetch and verify exact identity.

If GitLab branch protection rejects the update, do not weaken protections silently. Report the required maintainer action or use an approved GitLab administrator workflow.

## 9. Verification

### 9.1 Static and automated verification

Required commands:

```bash
npm run typecheck
npm test
```

Additional gates cover:

- package and product metadata
- canonical and legacy protocol behavior
- runtime variant selection
- data-root migration
- deprecated wrapper boundaries
- README clone URL and architecture claims
- absence of accidental public Mate Agent / Orkas branding

### 9.2 Runtime verification

Restart the source runtime from the cutover worktree:

```bash
scripts/restart-cogseed.sh
```

Verify:

- process argument is `--orkas-runtime-variant=cogseed`
- app root matches the cutover worktree
- app ID is `com.cogseed.desktop.source.cogseed`
- logs are written beneath `.cogseed/runtime-variants/cogseed/data/logs/`
- `cogseed://`, `mateagent://`, and `orkas://` register as expected
- renderer boot completes
- model authorization can preview CC Switch credentials
- Claude Code and Codex session import entrypoints remain available

### 9.3 Remote verification

After repository rename and `main` mirror:

```bash
git fetch origin develop main
test "$(git rev-parse origin/develop)" = "$(git rev-parse origin/main)"
git diff --exit-code origin/develop origin/main
```

The new GitLab URL must support fetch and push for the authorized user.

## 10. Rollback

The archive branch preserves the pre-cutover release line:

```text
archive/pre-cogseed-main-2026-08-11 → old origin/main SHA
```

Rollback steps:

1. Restore `main` from the archive branch with a lease-protected update.
2. If necessary, restore the GitLab path from `cogseed` to `mate-agent`.
3. Keep `develop` forward-moving; fix defects through a new branch and MR rather than rewriting `develop`.
4. Do not move user data back to `.orkas`; the retained old root is a compatibility backup, not an active write target.

## 11. Success Criteria

The cutover is complete only when all of the following are true:

- GitLab project display name is `CogSeed`.
- GitLab repository path is `cogseed`.
- Root README files accurately describe the current product and use the new clone URL.
- Current package/app/repository surfaces use CogSeed naming.
- Legacy identifiers remain only in explicit compatibility or historical contexts.
- `npm run typecheck` and `npm test` pass.
- Source runtime boots as CogSeed from the verified cutover commit.
- `origin/main` and `origin/develop` resolve to the same commit.
- `archive/pre-cogseed-main-2026-08-11` preserves the former `main` tip.
