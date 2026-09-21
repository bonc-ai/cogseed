# Windows Release-Gate Failures Design

## Goal

Make the Windows release gate deterministic and prevent conversation artifacts from being lost when a workspace is moved out of, into, or between spaces.

## Scope

The change addresses three observed failures:

1. Space-unbind workspace migration loses the source artifact when the destination slug already exists.
2. Space deletion can remove that same unmigrated source artifact with the deleted space directory.
3. The synthetic-envelope messaging test can hang during cleanup because it uses fake timers even though the behavior under test does not depend on the burst-merge window.

Packaging, remote branch updates, release publication, and unrelated refactors are out of scope.

## Design

### Isolated workspace tests

`conv-workspace-space.test.ts` will create a dedicated user-workspace directory beneath each test's `tmpDir` and select it through the existing `setWorkspacePath` API. Because the selected workspace and all space data then share the same per-test root, `afterEach` removes every artifact created by the test. This prevents the fixed `任务` slug from colliding with residue in the process-wide `%TEMP%\userWorkSpace` directory.

### Collision-safe workspace migration

`migrateConversationWorkspace` will preserve the current slug when the destination does not exist. If that destination is occupied, it will reuse the existing slug-uniquification convention and choose the first free suffix (`任务-2`, `任务-3`, and so on) within the destination root.

After a successful rename or copy-and-remove migration, the conversation's persisted `state.workspace_dir` will be updated to the chosen slug under the existing per-conversation state lock. A focused state helper will perform this deliberate replacement; `setWorkspaceDirOnce` keeps its existing frozen-on-first-resolution behavior for normal workspace creation.

The migration remains best-effort. If both rename and copy fallback fail, the source stays in place, the state slug is unchanged, the function returns `moved: false`, and the caller logs the failure. No existing destination is overwritten or merged.

### Messaging test timer ownership

The `seededInstance` test helper will accept whether fake timers are required. Burst-window tests will continue to use fake timers. The synthetic-envelope test will request real timers because it verifies immediate bypass behavior, not timer-driven merging. Cleanup will be protected by `try/finally` so `stopForUser`, timer restoration, mocks, and module state cannot leak when an assertion fails.

## Data flow

For a workspace ownership change:

1. Read the persisted source slug.
2. Resolve source and destination workspace roots.
3. If the source is absent, return without changing state.
4. Choose the original slug or a unique suffixed destination slug.
5. Rename the source; on filesystem-boundary or Windows rename failure, copy recursively and remove the source.
6. Persist the chosen slug when it differs from the original.
7. Return success so callers can log the completed move.

## Tests

TDD will add a regression that pre-creates an occupied destination slug, migrates a different conversation workspace, and asserts all of the following:

- the occupied destination remains unchanged;
- the source artifact arrives in a unique suffixed directory;
- `getConversationWorkspacePath` resolves to that suffixed directory afterward;
- the persisted state contains the suffixed slug.

The existing unbind, cross-space move, and delete-space scenarios must continue to pass with their original slug when no collision exists. The synthetic-envelope test will be run repeatedly to exercise Windows cleanup stability.

Final verification will run the focused tests, type checking, linting, Windows platform gates, platform-native tests, the complete serial test suite, `git diff --check`, and a final worktree status inspection. Success requires a fresh complete suite with zero failures.
