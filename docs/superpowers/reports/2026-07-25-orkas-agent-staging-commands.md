# Orkas Agent Staging Commands

**Status:** AWAITING USER APPROVAL — commands are written for review only and have not been executed.

These commands assume the user approves the complete staging map. They deliberately avoid `git add .`, `git add -A`, `git clean`, and `git reset`.

## Commit G

First stage the whole-file G paths:

```bash
git add -- \
  src/main/features/agents.ts \
  src/main/features/contexts.ts \
  src/main/features/group_chat/collaboration.ts \
  src/main/features/group_chat/index.ts \
  src/main/features/group_chat/visibility.ts \
  src/main/features/p3394/index.ts \
  src/main/features/p3394/kstar-engine.ts \
  src/main/features/p3394/kstar-kb.ts \
  src/main/features/p3394/kstar-notion.ts \
  src/main/features/p3394/protocol.ts \
  src/main/features/p3394/kstar-runtime.ts \
  src/main/features/p3394/types.ts \
  src/main/features/p3394/wake-controller.ts \
  src/main/features/p3394/wake-service.ts \
  src/main/prompts/chat_shared_task_context_protocol.md \
  src/main/prompts/chat_agent_in_group.md \
  src/main/prompts/chat_cli_agent.md \
  src/main/prompts/chat_commander.md \
  test/main/features/group_chat/collaboration.test.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/p3394/kstar-runtime.test.ts \
  test/main/features/p3394/kstar-engine.test.ts \
  test/main/features/p3394/kstar-kb.test.ts \
  test/main/features/p3394/kstar-notion.test.ts \
  test/main/features/p3394/protocol.test.ts \
  test/main/features/p3394/wake-controller.test.ts \
  test/main/features/p3394/wake-recovery.test.ts \
  test/main/features/p3394/wake-service.test.ts
```

Then review the two mixed files interactively:

```bash
git add -p -- src/main/features/group_chat/bus.ts
# Accept the integrated Collaboration/P3394 routing, protocol, gate,
# recovery, and removal of direct Hermes-as-Commander execution hunks.
# Reject only unrelated changes if any appear after the F baseline.

git add -p -- test/main/features/group_chat/bus.test.ts
# Accept the PROTOCOL_EVENT_TEST mock and protocol metadata test.
# Accept removal of obsolete direct-Hermes repair tests because G removes
# that execution path.
# Reject the replacement `ignores legacy Hermes commander backend config and
# runs the Orkas commander` test; it belongs to D with config migration.
```

Before committing G, show and review:

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached
```

Run the detached-candidate verification again against the exact cached G tree, then request per-commit approval before `git commit`.

## Commit C

After G is committed and reviewed, stage the approved IPC/renderer hunks. Do not stage the D-owned Commander settings hunks:

```bash
git add -p -- src/main/ipc/index.ts
# Accept protocol-events, KB/Notion, patch-candidate, and collaboration-conflict handlers.
# Reject settings.detectCommanderBackends removal; it belongs to D.

git add -p -- src/renderer/index.html
# Accept Collaboration/Protocol conversation-info tabs.
# Reject Commander backend settings markup; it belongs to D.

git add --   src/renderer/modules/ipc-shim.js   src/renderer/modules/conversation-info.js

git add -p -- src/renderer/modules/conversation.js
# Accept produced/review chips, KSTAR, Wake, collaboration/conflict UI hunks.
# Reject unrelated project pagination, relay, and sidebar activity hunks.

git add -p -- src/renderer/style.css
# Accept conversation-info, produced/review, KSTAR, and Wake styles only.

git add -p -- src/renderer/locales/en.json src/renderer/locales/ja.json src/renderer/locales/pt.json src/renderer/locales/zh.json
# Accept conversation-info, agent activity, collaboration, protocol, Wake,
# experience, and patch-center strings. Reject Commander/provider settings strings.
```

Then stage the C-owned tests:

```bash
git add --   test/renderer/conversation-agent-status.test.ts   test/renderer/conversation-info.test.ts   test/renderer/conversation-produced-chips.test.ts   test/renderer/ipc-shim.test.ts   test/renderer/p3394-experience-controls.test.ts   test/main/ipc/p3394-patch-candidates.test.ts   test/main/ipc/p3394-protocol-events.test.ts   test/renderer/agent-activity-panel.test.ts   test/renderer/collaboration-overview-drawer.test.ts   test/renderer/p3394-patch-candidates.test.ts   test/renderer/p3394-wake-placement.test.ts
```

For `test/renderer/conversation-produced-chips.test.ts`, accept only the produced-chip assertion hunk. Reject the separate process-log folding test; that test belongs with G follow-up hunk 46.

`test/renderer/conversation-sidebar.test.ts` is not included in this C command yet because its current additions test conversation-list/project pagination and stale-page protection, not the collaboration/P3394 surface. Keep it unstaged for a separate classification.

Review with:

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached
```

## Commit D

After C is committed and reviewed, stage the approved Commander/provider migration:

```bash
git add -- \
  bootstrap.cjs \
  run.sh \
  run.cmd \
  src/main/features/auth.ts \
  src/main/features/commander_backend.ts \
  src/main/features/config.ts \
  src/main/model/core-agent/external-providers.ts \
  src/main/model/core-agent/runner.ts \
  src/main/features/commander_backends/hermes.ts \
  test/main/features/commander-backend-hermes-decision.test.ts \
  test/main/features/agents.test.ts \
  test/main/features/auth.test.ts \
  test/main/features/commander-backend-routing.test.ts \
  test/main/features/commander-backend-settings.test.ts \
  test/main/model/core-agent/external-providers.test.ts \
  test/main/prompts/contract.test.ts
```

If `agents.ts`, `contexts.ts`, prompt files, or renderer settings files still contain mixed D hunks after G/C, stage those hunks with `git add -p` and reject all already-landed G/C hunks.

Before committing D:

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached
```

## Safety gate

Do not execute any staging command in this report until the user approves the complete map. Do not commit until the user separately approves each cached diff.
