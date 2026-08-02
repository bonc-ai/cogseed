# 会话复制与合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add one-conversation copy and multi-conversation merge flows that create a new conversation with remapped Commander/agent sessions, preserve or compress private context correctly, and expose both actions in the renderer.

**Architecture:** Put all cloning/merging business logic in a new main-side feature so IPC only validates inputs and dispatches. Reuse existing conversation metadata, group-chat member/state persistence, and core-agent session sidecars; copy uses a mostly direct remap, while merge builds a structured summary and per-agent merged private summaries. Renderer changes stay in `conversation.js` plus locale strings and only surface the new actions, confirmation dialogs, progress, and result cards.

**Tech Stack:** Electron main process, vanilla renderer JS, IPC handlers, `fs`/`path`, existing `chats`, `group_chat/state`, `group_chat/collaboration`, `session-store`, Vitest.

---

### Task 1: Add failing backend tests for clone and merge primitives

**Files:**
- Create: `test/main/features/conversation-copy-merge.test.ts`
- Modify: `test/main/features/conversation-copy-merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';

describe('conversation copy and merge primitives', () => {
  it('copies a conversation to a new cid and remaps commander/member session ids', async () => {
    const result = await cloneConversationForTest(/* source cid */ 'old123');
    expect(result.newConversation.conversation_id).toBe('new456');
    expect(result.commanderSessionId).toBe('gconv-new456');
    expect(result.memberSessionIds).toContain('gmember-new456-agentA');
  });

  it('merges multiple conversations into one summary and groups private context by agent_id', async () => {
    const result = await mergeConversationsForTest(['convA', 'convB']);
    expect(result.summaryMessage).toContain('已合并');
    expect(result.agentSummaries).toHaveProperty('agentA');
    expect(result.agentSummaries.agentA.sourceCids).toEqual(['convA', 'convB']);
  });
});
```

- [ ] **Step 2: Run the new test file and confirm it fails because the helper API does not exist yet**

Run: `npm test -- test/main/features/conversation-copy-merge.test.ts -v`
Expected: FAIL with missing export / unresolved helper names.

- [ ] **Step 3: Keep the test file as the specification for the new feature API**

Use the test to pin the public shape before writing implementation.

- [ ] **Step 4: Commit the test-only change**

```bash
git add test/main/features/conversation-copy-merge.test.ts
git commit -m "test: specify conversation copy and merge primitives"
```

### Task 2: Implement the main-side copy/merge feature

**Files:**
- Create: `src/main/features/conversation_copy_merge.ts`
- Modify: `src/main/features/chats.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `src/main/model/core-agent/session-store.ts`

- [ ] **Step 1: Write the minimal feature functions and helper types**

```ts
export interface CloneConversationResult {
  newConversation: Conversation;
  commanderSessionId: string;
  memberSessionIds: string[];
}

export interface MergeConversationResult {
  newConversation: Conversation;
  summaryMessage: string;
  agentSummaries: Record<string, { sourceCids: string[]; markdown: string }>;
}

export async function cloneConversation(userId: string, sourceCid: string, opts?: { projectIdHint?: string | null }): Promise<CloneConversationResult>;
export async function mergeConversations(userId: string, sourceCids: string[], opts?: { title: string; projectIdHint?: string | null }): Promise<MergeConversationResult>;
```

Implement them by reusing `chats.getConversation`, `group_chat/state.readMembers`, `group_chat/state.readState`, `group_chat/collaboration.readActiveCollaborationSnapshot`, and `session-store` path helpers.

- [ ] **Step 2: Make the copy flow create a new conversation and remap all session ids**

Copy the source conversation metadata, create a fresh `cid`, write a new conversation row, and duplicate the source UI messages without copying attachment/artifact/file bytes. Remap commander and member session ids from `gconv-<sourceCid>` / `gmember-<sourceCid>-<agentId>` to the new cid.

- [ ] **Step 3: Make the merge flow build a structured summary and per-agent private summaries**

Group source data by `agent_id`, keep separate workstreams when the same agent has different responsibilities in different source conversations, and render the merged private context as Markdown with `Source Workstreams`, `Cross-cutting Facts`, `Current Responsibility`, `Open Questions`, `Conflicts / Risks`, and `Resource Index` sections.

- [ ] **Step 4: Add cleanup and fallback behavior for partial source data**

If a source session or `.context.json` sidecar is missing, skip only that source fragment, keep the rest of the clone/merge result, and avoid leaving a half-created destination conversation behind.

- [ ] **Step 5: Run the feature tests and confirm copy and merge pass**

Run: `npm test -- test/main/features/conversation-copy-merge.test.ts -v`
Expected: PASS.

- [ ] **Step 6: Commit the backend implementation**

```bash
git add src/main/features/conversation_copy_merge.ts src/main/features/chats.ts src/main/features/group_chat/state.ts src/main/features/group_chat/collaboration.ts src/main/model/core-agent/session-store.ts test/main/features/conversation-copy-merge.test.ts
git commit -m "feat: add conversation copy and merge core logic"
```

### Task 3: Wire new IPC handlers for clone and merge

**Files:**
- Modify: `src/main/ipc/index.ts`
- Create: `test/main/ipc/conversation-copy-merge.test.ts`

- [ ] **Step 1: Write the failing IPC test**

```ts
it('exposes conversations.clone and conversations.merge through IPC', async () => {
  const clone = await invoke('conversations.clone', { cid: 'old123' });
  expect(clone.conversation).toBeTruthy();

  const merge = await invoke('conversations.merge', { cids: ['a', 'b'], title: 'Merged title' });
  expect(merge.conversation).toBeTruthy();
  expect(merge.summary).toContain('已合并');
});
```

- [ ] **Step 2: Add the handlers in `src/main/ipc/index.ts`**

Validate `cid`/`cids`, preserve the existing project hint semantics, call the new feature functions, and return `{ conversation, summary, agent_summaries }` payloads in the same style as other conversation handlers.

- [ ] **Step 3: Run the IPC test and confirm both handlers pass**

Run: `npm test -- test/main/ipc/conversation-copy-merge.test.ts -v`
Expected: PASS.

- [ ] **Step 4: Commit the IPC wiring**

```bash
git add src/main/ipc/index.ts test/main/ipc/conversation-copy-merge.test.ts
git commit -m "feat: wire conversation copy and merge ipc"
```

### Task 4: Add renderer actions, dialogs, progress, and result cards

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/modules/ipc-shim.js`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `src/renderer/style.css`
- Create: `test/renderer/conversation-copy-merge.test.js`

- [ ] **Step 1: Write the failing renderer test for menu item, multi-select action bar, and result cards**

```js
it('renders copy and merge actions and the merged summary card', () => {
  renderConversationItem({ conversation_id: 'c1' });
  expect(screen.getByText('复制会话')).toBeTruthy();

  renderMultiSelectBar({ selectedCount: 2 });
  expect(screen.getByText('合并为新会话')).toBeTruthy();

  renderMergedSummaryCard({ sourceCount: 2, agentCount: 1 });
  expect(screen.getByText('已合并 2 个会话')).toBeTruthy();
});
```

- [ ] **Step 2: Add the single-conversation copy menu item and confirmation dialog**

Add the `复制会话` action to the existing conversation action menu and reuse the existing modal/dialog patterns for the confirmation, loading state, success toast, and the top-of-chat copy notice card.

- [ ] **Step 3: Add the multi-select merge entry and merge confirmation dialog**

Add a selection mode to the conversation list if needed, show the `已选择 n 个会话` action bar, and add the merge dialog with a title input, selected source list, and the merge explanation copy.

- [ ] **Step 4: Render the merged summary card and expand/collapse details**

Insert the merged summary card at the top of the new conversation history and render the `Source Conversations`, `Confirmed Decisions`, `Current State`, `Agent Private Context Index`, `Source References`, `Open Questions`, and `Conflicts / Risks` sections on expand.

- [ ] **Step 5: Add locale strings and styles**

Translate every visible string into the four existing renderer locale files and add CSS for the top notice card, merge summary card, selection bar, and loading state.

- [ ] **Step 6: Run the renderer tests**

Run: `npm test -- test/renderer/conversation-copy-merge.test.js -v`
Expected: PASS.

- [ ] **Step 7: Commit the renderer work**

```bash
git add src/renderer/modules/conversation.js src/renderer/modules/ipc-shim.js src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json src/renderer/style.css test/renderer/conversation-copy-merge.test.js
git commit -m "feat: add conversation copy and merge ui"
```

### Task 5: Verify end-to-end behavior and regression coverage

**Files:**
- Modify: `test/main/features/conversation-copy-merge.test.ts`
- Modify: `test/main/ipc/conversation-copy-merge.test.ts`
- Modify: `test/renderer/conversation-copy-merge.test.js`

- [ ] **Step 1: Add a full flow test that clones then merges sample conversations with agent-private context differences**

Cover the exact edge case discussed in design: the same `agent_id` doing design in one source conversation and research in another, with the merged private context preserving two separate workstreams.

- [ ] **Step 2: Run the focused backend, IPC, and renderer suites**

Run:

```bash
npm test -- test/main/features/conversation-copy-merge.test.ts -v
npm test -- test/main/ipc/conversation-copy-merge.test.ts -v
npm test -- test/renderer/conversation-copy-merge.test.js -v
```

Expected: all PASS.

- [ ] **Step 3: Run the broader conversation and session regression suites that already cover related code paths**

Run:

```bash
npm test -- test/main/ipc/conversations-send-stream.test.ts -v
npm test -- test/renderer/conversation-list-pagination.test.ts -v
npm test -- test/renderer/conversation-info.test.ts -v
```

Expected: PASS with no regressions in existing conversation flows.

- [ ] **Step 4: Commit the verification updates**

```bash
git add test/main/features/conversation-copy-merge.test.ts test/main/ipc/conversation-copy-merge.test.ts test/renderer/conversation-copy-merge.test.js
git commit -m "test: cover conversation copy and merge end to end"
```

## Verification

- New backend tests prove the feature API exists and remaps session ids correctly.
- IPC tests prove the renderer can invoke clone/merge through the approved handlers.
- Renderer tests prove the new menu item, merge selection action, dialogs, and summary card render the expected text.
- Regression tests ensure existing conversation send, list, and info flows still work after the new actions land.

## Self-review

1. **Spec coverage:**
   - Copy flow: covered by Task 2, Task 3, Task 4, Task 5.
   - Merge flow: covered by Task 2, Task 3, Task 4, Task 5.
   - New cid and remapped session ids: Task 2 and Task 5.
   - No attachment/artifact/file body copy: Task 2 and Task 4 copy notice text.
   - Same `agent_id` multi-workstream merge: Task 2 and Task 5.
   - UI copy actions / merge selection / result cards: Task 4.

2. **Placeholder scan:**
   - No TODO/TBD/placeholder steps remain.
   - Every step has a concrete command, expected result, and a file target.

3. **Type consistency:**
   - The new feature API uses `cloneConversation` and `mergeConversations` consistently across backend, IPC, and tests.
   - IPC response payloads consistently return `conversation` plus summary fields.
   - Renderer text uses the same copy/merge labels across dialogs, bars, and cards.

## Next skill: $superpower-subagents
