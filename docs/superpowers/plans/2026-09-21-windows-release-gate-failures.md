# Windows Release-Gate Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows release test gate deterministic and preserve conversation artifacts when a workspace migration encounters an occupied destination slug.

**Architecture:** Keep workspace naming in `conv_workspace.ts`, but add one locked compare-and-set helper in `state.ts` so a successful collision-resolving move can update the frozen slug safely. Isolate the affected filesystem tests through the existing user-workspace API, and let only timer-dependent messaging tests opt into fake timers.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, PowerShell, npm scripts.

---

### Task 1: Isolate workspace tests and reproduce the collision

**Files:**
- Modify: `test/main/features/group-chat/conv-workspace-space.test.ts:14-26`
- Test: `test/main/features/group-chat/conv-workspace-space.test.ts`

- [ ] **Step 1: Route each test's selected user workspace into its own temporary root**

Extend `beforeEach` after `users.activateUser(UID)` so all workspace artifacts are covered by the existing `tmpDir` cleanup:

```ts
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const selectedWorkspace = path.join(tmpDir, 'user-workspace');
  fs.mkdirSync(selectedWorkspace, { recursive: true });
  expect(userWorkspace.setWorkspacePath(UID, selectedWorkspace)).toEqual({
    ok: true,
    path: selectedWorkspace,
  });
```

- [ ] **Step 2: Add the occupied-destination regression test**

Add this case to the `方案 Y` describe block:

```ts
  it('目标 slug 已占用时迁到唯一目录并更新会话工作区状态', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await import('../../../../src/main/features/group_chat/conv_workspace');
    const state = await import('../../../../src/main/features/group_chat/state');
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    const { cid } = await makeBoundConv('冲突空间');
    const occupied = path.join(getWorkspacePath(UID), '任务');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, '已有.txt'), 'keep');

    await chats.setConversationSpace(UID, cid, null);

    const migrated = path.join(getWorkspacePath(UID), '任务-2');
    expect(await convWs.getConversationWorkspacePath(UID, cid)).toBe(migrated);
    expect(fs.readFileSync(path.join(occupied, '已有.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(migrated, '成果.docx'), 'utf8')).toBe('x');
    expect((await state.readState(UID, cid)).workspace_dir).toBe('任务-2');
  });
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node scripts/run-tests.mjs run test/main/features/group-chat/conv-workspace-space.test.ts --maxWorkers=1
```

Expected: the new test fails because the resolved path remains `任务` instead of `任务-2`; the existing no-collision cases pass in the isolated workspace.

### Task 2: Migrate to a unique slug without overwriting data

**Files:**
- Modify: `src/main/features/group_chat/state.ts:1171-1183`
- Modify: `src/main/features/group_chat/conv_workspace.ts:34-40`
- Modify: `src/main/features/group_chat/conv_workspace.ts:145-190`
- Test: `test/main/features/group-chat/conv-workspace-space.test.ts`

- [ ] **Step 1: Add a locked compare-and-set state helper**

Add after `setWorkspaceDirOnce`:

```ts
/** Replace a frozen workspace slug after a successful ownership migration.
 * The expected value prevents a stale migration from overwriting a newer one. */
export async function replaceWorkspaceDir(
  uid: string,
  cid: string,
  expectedDir: string,
  nextDir: string,
): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    if (s.workspace_dir !== expectedDir) return s;
    s.workspace_dir = nextDir;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}
```

- [ ] **Step 2: Select a free destination and persist it after the move**

Import `replaceWorkspaceDir`, resolve a `destinationRoot`, and replace the early destination-exists return with:

```ts
  const destinationRoot = toSpaceId
    ? spaceWorkspaceDir(uid, toSpaceId)
    : getWorkspacePath(uid);
  const destinationSlug = uniquifySlug(destinationRoot, workspaceDir);
  const to = path.join(destinationRoot, destinationSlug);
```

After either rename or copy-and-remove succeeds, update the state only when the slug changed:

```ts
  if (destinationSlug !== workspaceDir) {
    const persisted = await replaceWorkspaceDir(uid, cid, workspaceDir, destinationSlug);
    if (persisted.workspace_dir !== destinationSlug) {
      log.warn(`workspace slug changed during migration cid=${cid}; moved files remain at dir=${destinationSlug}`);
      return { moved: false };
    }
  }
```

Keep the original slug when the target is free, never merge into an existing directory, and leave state unchanged when both rename and copy fail. Use `destinationSlug` in success logs.

- [ ] **Step 3: Run the workspace suite and verify GREEN**

Run:

```powershell
node scripts/run-tests.mjs run test/main/features/group-chat/conv-workspace-space.test.ts --maxWorkers=1
```

Expected: every test passes, including the collision regression and existing unbind, cross-space, and deletion cases.

- [ ] **Step 4: Commit the workspace fix**

```powershell
git add src/main/features/group_chat/state.ts src/main/features/group_chat/conv_workspace.ts test/main/features/group-chat/conv-workspace-space.test.ts
git commit -m "fix: preserve workspaces on space migration collisions"
```

### Task 3: Remove fake timers from the synthetic-envelope path

**Files:**
- Modify: `test/main/features/messaging.test.ts:2861-2901`
- Modify: `test/main/features/messaging.test.ts:2958-2977`
- Test: `test/main/features/messaging.test.ts`

- [ ] **Step 1: Make fake timers an explicit helper option**

Change the helper signature and its timer setup to:

```ts
  async function seededInstance(
    uid: string,
    options: { useFakeTimers?: boolean } = {},
  ): Promise<{
    manager: typeof import('../../../src/main/features/messaging/manager');
    groupSend: ReturnType<typeof vi.fn>;
  }> {
    if (options.useFakeTimers !== false) vi.useFakeTimers();
```

The default remains fake timers, so all burst-window tests retain current behavior.

- [ ] **Step 2: Run the synthetic test with real timers and deterministic cleanup**

Use `{ useFakeTimers: false }` and wrap the body in `try/finally`:

```ts
  it('dispatches synthetic envelopes immediately, bypassing the merger', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid, { useFakeTimers: false });
    try {
      const instanceId = (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id;
      await manager.enqueueInbound(uid, {
        platform: 'feishu_lark',
        instanceId,
        externalMessageId: 'evt-1',
        externalChatId: 'oc_1',
        externalUserId: uid,
        text: 'reaction:added:THUMBSUP',
        isGroup: true,
        mentionPresent: true,
        synthetic: true,
        receivedAt: new Date().toISOString(),
      });
      expect(groupSend).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stopForUser(uid);
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 3: Run the synthetic test five consecutive times**

Run:

```powershell
1..5 | ForEach-Object {
  node scripts/run-tests.mjs run test/main/features/messaging.test.ts -t "dispatches synthetic envelopes immediately, bypassing the merger" --maxWorkers=1
  if ($LASTEXITCODE -ne 0) { throw "synthetic iteration $_ failed" }
}
```

Expected: all five runs pass and each process exits normally without the previous 60-second cleanup timeout.

- [ ] **Step 4: Run the complete burst-merge describe block**

Run:

```powershell
node scripts/run-tests.mjs run test/main/features/messaging.test.ts -t "messaging burst merge on inbound" --maxWorkers=1
```

Expected: every burst-merge test passes, proving fake-timer coverage is preserved.

- [ ] **Step 5: Commit the messaging harness fix**

```powershell
git add test/main/features/messaging.test.ts
git commit -m "test: stabilize synthetic messaging cleanup on Windows"
```

### Task 4: Run the Windows release verification matrix

**Files:**
- Verify: repository-wide checks only

- [ ] **Step 1: Run static verification**

```powershell
npm run typecheck
npm run lint
```

Expected: both commands exit 0.

- [ ] **Step 2: Run Windows-specific and native-platform gates**

```powershell
npm run test:p3394:windows
npm run test:platform-native
```

Expected: both commands exit 0.

- [ ] **Step 3: Run the complete serial test suite**

```powershell
node scripts/run-tests.mjs run --maxWorkers=1
```

Expected: exit 0 with zero failed files and zero failed tests.

- [ ] **Step 4: Inspect the final diff and worktree**

```powershell
git diff --check
git status --short --branch
git log -3 --oneline --decorate
```

Expected: no whitespace errors; branch is `fix/windows-release-gate-failures`; only intentional commits are present; no uncommitted implementation changes remain.
