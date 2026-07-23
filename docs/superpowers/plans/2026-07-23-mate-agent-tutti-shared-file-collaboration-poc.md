# Mate Agent Tutti Research And Shared File Collaboration POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Confirm Tutti's agent communication model, then run a smallest-possible Mate Agent POC where Hermes and Codex coordinate through shared `task.md` / `plan.md` state.

**Architecture:** This plan deliberately precedes the heavier WorkflowRun/SharedTaskContext implementation. P0 produces a grounded research note from the confirmed `tutti-os/tutti` repository. P1 creates a local, human-readable shared-file collaboration notebook in the Mate Agent project root, with append-only event history so two short-lived agent processes can exchange durable state without Redis.

**Tech Stack:** Markdown, JSONL, shell, Git, existing Mate Agent workspace. No new npm dependencies, no Redis, no HTTP server, no new local agent spawn path.

---

## File Structure

### Files created

- `/Users/sudai/Documents/Mate Agent/docs/research/tutti-agent-communication.md`
  - Records the confirmed Tutti repository, inspected source files, and the communication lessons we will apply to Mate Agent.
- `/Users/sudai/Documents/Mate Agent/task.md`
  - Human-readable current collaboration task state for the POC.
- `/Users/sudai/Documents/Mate Agent/plan.md`
  - Human-readable current collaboration plan for the POC.
- `/Users/sudai/Documents/Mate Agent/.collab-poc/events.jsonl`
  - Append-only event ledger. This is the POC's source of truth when `task.md` or `plan.md` is rewritten.
- `/Users/sudai/Documents/Mate Agent/.collab-poc/README.md`
  - Explains how Hermes and Codex should read/write the shared files.

### Files modified

- `/Users/sudai/Documents/Mate Agent/.gitignore`
  - Add local POC state ignores so `task.md`, `plan.md`, and `.collab-poc/` do not become product source by accident.
- `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`
  - Add a short priority update: P0 Tutti research and P1 shared-file POC must happen before formal WorkflowRun/SharedTaskContext implementation.

### Files not touched

- `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/bus.ts`
- `/Users/sudai/Documents/Mate Agent/src/main/features/local_agents/runner.ts`
- `/Users/sudai/Documents/Mate Agent/src/main/preload.js`
- `/Users/sudai/Documents/Mate Agent/src/renderer/**`

This POC is intentionally external to runtime code. It validates the communication mechanism before changing Mate Agent behavior.

---

## Task 1: Document Tutti Agent Communication Mechanism

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/docs/research/tutti-agent-communication.md`

- [ ] **Step 1: Create the research directory**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
mkdir -p docs/research
```

Expected: `docs/research` exists.

- [ ] **Step 2: Fetch a fresh local copy of the confirmed Tutti source**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
TUTTI_RESEARCH_DIR="$(mktemp -d /tmp/mate-agent-tutti-research.XXXXXX)"
git clone --depth 1 --filter=blob:none https://github.com/tutti-os/tutti.git "$TUTTI_RESEARCH_DIR"
printf '%s\n' "$TUTTI_RESEARCH_DIR"
```

Expected: command prints a `/tmp/mate-agent-tutti-research.*` directory and exits successfully.

- [ ] **Step 3: Verify the source locations used by the research note**

Run, replacing `$TUTTI_RESEARCH_DIR` with the printed directory if the shell variable is not still present:

```bash
cd "$TUTTI_RESEARCH_DIR"
for f in \
  docs/architecture/agent-gui-node.md \
  docs/specs/2026-07-15-provider-native-subagents.md \
  docs/architecture/workspace-workflows.md \
  packages/agent/runtimeprep/skill_templates/tutti-handoff.md \
  packages/agent/runtimeprep/skill_templates/tutti-cli.md \
  services/tuttid/service/cli/providers/agentcontext/session_commands.go \
  services/tuttid/service/agent/collab_timeline.go
  do
    test -f "$f" && echo "found $f"
  done
```

Expected: seven `found ...` lines.

- [ ] **Step 4: Write the research note**

Create `/Users/sudai/Documents/Mate Agent/docs/research/tutti-agent-communication.md` with this content:

```markdown
# Tutti Agent Communication Research

Date: 2026-07-23  
Repository: https://github.com/tutti-os/tutti  
Purpose: Understand how Tutti passes work and state between agents so Mate Agent can choose a near-term collaboration mechanism.

## 1. Confirmed source files inspected

- `docs/architecture/agent-gui-node.md`
- `docs/specs/2026-07-15-provider-native-subagents.md`
- `docs/architecture/workspace-workflows.md`
- `packages/agent/runtimeprep/skill_templates/tutti-handoff.md`
- `packages/agent/runtimeprep/skill_templates/tutti-cli.md`
- `services/tuttid/service/cli/providers/agentcontext/session_commands.go`
- `services/tuttid/service/agent/collab_timeline.go`

## 2. High-level finding

Tutti does not rely on two agent processes sharing memory. It uses durable identities, session records, turn records, message projections, and CLI commands to move work between agents. Mentions such as agent-target or agent-session references are routing handles, not the complete communication channel.

## 3. Communication model

Tutti's durable communication model can be summarized as:

```text
mention / user intent
  -> exact agent target or existing agent session
  -> agent start or agent send
  -> durable session / turn / message state
  -> agent wait for a stop point
  -> agent get only when result context is needed
  -> collaboration timeline row visible in the source transcript
```

Important details:

1. `agent start` creates a new session for a selected agent target.
2. `agent send` sends input to an existing session.
3. `agent wait` waits for the next stop point without repeatedly fetching live transcript content.
4. `agent get` is used for result recovery or context consumption, not progress polling.
5. Collaboration runs are projected into the source session as visible `collaboration` timeline messages.
6. Provider-native subagents are durable child sessions with explicit parent/root relations.

## 4. Handoff rules worth copying

From Tutti's handoff skill, the useful rules for Mate Agent are:

1. Decide who executes before doing work locally.
2. Decide what exact task is handed off.
3. Decide how results return: delegate, fetch, or collaborate.
4. After delegation, act at stop points instead of consuming partial progress continuously.
5. Follow-up instructions go to the same session, not a duplicate new session.
6. Completion must be traceable to executor, task, return path, and session id.

## 5. Apple Shortcuts note

Richard mentioned Apple Shortcuts as an application-to-application pass mechanism. In the public `tutti-os/tutti` source inspected for this note, the durable agent communication path is centered on Tutti daemon/session/turn/CLI state. Apple Shortcuts may exist in a separate version, private branch, or related application automation layer, but it should be treated as a wakeup/transport candidate rather than the durable state source.

For Mate Agent, the portable lesson is:

```text
transport can vary, durable state must be explicit
```

## 6. Mate Agent implications

For Mate Agent's immediate problem — Hermes and Codex are separate processes and lose in-memory state after each run — the minimum useful bridge is a shared durable state file.

Recommended POC shape:

```text
Mate Agent project root
├── task.md
├── plan.md
└── .collab-poc/
    ├── README.md
    └── events.jsonl
```

`task.md` and `plan.md` are human-readable snapshots. `.collab-poc/events.jsonl` is append-only history so one agent's update is not lost when another rewrites a snapshot.

## 7. Decision for this POC

Proceed with a shared-file POC before adding Redis or implementing the formal WorkflowRun runtime.

The POC succeeds if:

1. Hermes can read the shared files, append its state, and exit.
2. Codex can read Hermes's persisted state, append review or next-step state, and exit.
3. A later Hermes or Codex run can recover the whole collaboration state from disk.
4. The append-only event log preserves both agents' updates.
5. No Mate Agent runtime code needs to change for the POC.
```

- [ ] **Step 5: Verify the research note contains the expected source references**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
grep -n "agent wait\|collaboration timeline\|events.jsonl\|Apple Shortcuts" docs/research/tutti-agent-communication.md
```

Expected: output includes all four searched terms.

---

## Task 2: Mark Shared-File POC As Local State

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/.gitignore`

- [ ] **Step 1: Add local POC ignores**

Append this block to `/Users/sudai/Documents/Mate Agent/.gitignore` if the entries are not already present:

```gitignore

# Local multi-agent shared-file collaboration POC state
task.md
plan.md
.collab-poc/
```

- [ ] **Step 2: Verify ignore rules**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
git check-ignore task.md plan.md .collab-poc/events.jsonl
```

Expected:

```text
task.md
plan.md
.collab-poc/events.jsonl
```

---

## Task 3: Create Shared File POC State

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/task.md`
- Create: `/Users/sudai/Documents/Mate Agent/plan.md`
- Create: `/Users/sudai/Documents/Mate Agent/.collab-poc/events.jsonl`
- Create: `/Users/sudai/Documents/Mate Agent/.collab-poc/README.md`

- [ ] **Step 1: Create POC directory and event log**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
mkdir -p .collab-poc
: > .collab-poc/events.jsonl
```

Expected: `.collab-poc/events.jsonl` exists and is empty.

- [ ] **Step 2: Create `task.md`**

Create `/Users/sudai/Documents/Mate Agent/task.md` with this content:

```markdown
# Mate Agent Shared Collaboration Task

Run ID: collab-poc-2026-07-23-001  
Status: running  
Updated At: 2026-07-23T00:00:00Z

## Objective

Validate whether Hermes and Codex can collaborate across separate short-lived processes by reading and writing shared files.

## Current State

- Hermes: pending first write.
- Codex: pending review after Hermes writes.
- Overall phase: initialization.

## Confirmed Facts

- Hermes and Codex may run as separate processes.
- Process memory is not a reliable shared context after an agent exits.
- Shared files can provide a minimal durable state bridge.
- This POC intentionally does not use Redis.

## Decisions

- Use `task.md` for current task state.
- Use `plan.md` for the execution plan.
- Use `.collab-poc/events.jsonl` as append-only event history.
- Do not change Mate Agent runtime code during this POC.

## Open Questions

- Does append-only file state give enough continuity for a two-agent discussion?
- Do Hermes and Codex need a helper command, or are direct file reads/writes enough?
- What fields are required before this becomes a formal WorkflowRun/SharedTaskContext implementation?

## Agent Inbox

### To Hermes

Read `task.md`, `plan.md`, and `.collab-poc/events.jsonl`. Append one JSONL event describing your current understanding and update the Hermes line in Current State.

### To Codex

After Hermes writes, read the same files. Append one JSONL event reviewing Hermes's update and update the Codex line in Current State.

## Last Updates

- 2026-07-23 system: initialized shared-file collaboration POC.
```

- [ ] **Step 3: Create `plan.md`**

Create `/Users/sudai/Documents/Mate Agent/plan.md` with this content:

```markdown
# Mate Agent Shared Collaboration Plan

## Goal

Run one observable Hermes ↔ Codex collaboration loop using only shared files.

## Roles

- Hermes: first-pass proposal writer.
- Codex: reviewer and second-pass state updater.

## Shared Files

- `task.md`: current state snapshot.
- `plan.md`: planned steps and completion criteria.
- `.collab-poc/events.jsonl`: append-only event ledger.

## Steps

- [ ] Step 1: Initialize shared files.
- [ ] Step 2: Hermes reads all shared files and appends a `hermes.proposal` event.
- [ ] Step 3: Hermes updates `task.md` Current State and Last Updates.
- [ ] Step 4: Codex reads all shared files and appends a `codex.review` event.
- [ ] Step 5: Codex updates `task.md` Current State, Decisions, Open Questions, and Last Updates.
- [ ] Step 6: Run a final readback to confirm both agents' state survived process boundaries.

## Event Format

Each line in `.collab-poc/events.jsonl` is one JSON object:

```json
{"ts":"2026-07-23T00:00:00Z","agent":"system","type":"initialized","summary":"Shared collaboration POC initialized.","next":"Hermes writes first proposal."}
```

Required fields:

- `ts`: ISO timestamp.
- `agent`: `system`, `hermes`, or `codex`.
- `type`: event type such as `initialized`, `hermes.proposal`, `codex.review`, or `final.readback`.
- `summary`: short human-readable summary.
- `next`: next expected action.

## Completion Criteria

- `events.jsonl` contains at least one `hermes.proposal` event.
- `events.jsonl` contains at least one `codex.review` event.
- `task.md` shows both Hermes and Codex state.
- A fresh process can reconstruct the current collaboration state by reading files from disk.
- No Redis, HTTP server, app runtime code change, or new CLI spawn path is used.
```

- [ ] **Step 4: Create `.collab-poc/README.md`**

Create `/Users/sudai/Documents/Mate Agent/.collab-poc/README.md` with this content:

```markdown
# Shared File Collaboration POC

This directory supports a local Mate Agent experiment: Hermes and Codex exchange durable state through shared files instead of process memory.

## Read order for every agent run

1. Read `/Users/sudai/Documents/Mate Agent/task.md`.
2. Read `/Users/sudai/Documents/Mate Agent/plan.md`.
3. Read `/Users/sudai/Documents/Mate Agent/.collab-poc/events.jsonl`.
4. Decide whether the current agent has an assigned inbox item.
5. Append exactly one JSON object to `events.jsonl` before rewriting snapshots.
6. Update only the sections of `task.md` or `plan.md` that the current step owns.

## Write discipline

- Treat `events.jsonl` as append-only.
- Treat `task.md` and `plan.md` as snapshots.
- Never delete another agent's Last Updates entry.
- If a conflict is found, append a conflict event instead of silently overwriting the other agent's state.
- This POC is local state and is intentionally ignored by Git.

## Event example

```json
{"ts":"2026-07-23T00:00:00Z","agent":"hermes","type":"hermes.proposal","summary":"Hermes proposes shared files as durable state bridge.","next":"Codex reviews the proposal."}
```
```

- [ ] **Step 5: Add initial system event**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
printf '%s\n' '{"ts":"2026-07-23T00:00:00Z","agent":"system","type":"initialized","summary":"Shared collaboration POC initialized.","next":"Hermes writes first proposal."}' >> .collab-poc/events.jsonl
```

Expected: `.collab-poc/events.jsonl` has exactly one line.

---

## Task 4: Run Manual Hermes/Codex Shared-State Simulation

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/task.md`
- Modify: `/Users/sudai/Documents/Mate Agent/.collab-poc/events.jsonl`

This task can be run manually in the current shell if Hermes/Codex are not launched yet. It proves the file protocol itself works before wiring real agent invocations.

- [ ] **Step 1: Simulate Hermes append**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
printf '%s\n' '{"ts":"2026-07-23T00:01:00Z","agent":"hermes","type":"hermes.proposal","summary":"Hermes confirms shared files are sufficient for a first durable state bridge because later processes can recover from disk.","next":"Codex reviews whether append-only events plus markdown snapshots avoid state loss."}' >> .collab-poc/events.jsonl
```

Expected: `.collab-poc/events.jsonl` contains a `hermes.proposal` event.

- [ ] **Step 2: Update Hermes state in `task.md`**

Edit `/Users/sudai/Documents/Mate Agent/task.md` so `## Current State` becomes:

```markdown
## Current State

- Hermes: wrote first proposal to `.collab-poc/events.jsonl`.
- Codex: pending review after Hermes writes.
- Overall phase: hermes_proposed.
```

Also append this line under `## Last Updates`:

```markdown
- 2026-07-23 Hermes: proposed shared files as the first durable state bridge.
```

- [ ] **Step 3: Simulate Codex append**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
printf '%s\n' '{"ts":"2026-07-23T00:02:00Z","agent":"codex","type":"codex.review","summary":"Codex agrees with the POC but requires append-only events to be treated as the source of truth and markdown files as snapshots.","next":"Final readback verifies both agent updates survive process boundaries."}' >> .collab-poc/events.jsonl
```

Expected: `.collab-poc/events.jsonl` contains both `hermes.proposal` and `codex.review`.

- [ ] **Step 4: Update Codex state in `task.md`**

Edit `/Users/sudai/Documents/Mate Agent/task.md` so `## Current State` becomes:

```markdown
## Current State

- Hermes: wrote first proposal to `.collab-poc/events.jsonl`.
- Codex: reviewed Hermes proposal and accepted append-only events as source of truth.
- Overall phase: codex_reviewed.
```

Append this bullet under `## Decisions` if not already present:

```markdown
- Treat `.collab-poc/events.jsonl` as the POC source of truth; treat `task.md` and `plan.md` as snapshots.
```

Append this line under `## Last Updates`:

```markdown
- 2026-07-23 Codex: reviewed the shared-file protocol and accepted append-only event history as required.
```

- [ ] **Step 5: Verify readback**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
cat task.md
printf '\n--- events ---\n'
cat .collab-poc/events.jsonl
```

Expected:

- `task.md` shows Hermes and Codex as updated.
- `.collab-poc/events.jsonl` contains three lines: `initialized`, `hermes.proposal`, and `codex.review`.

---

## Task 5: Update The Existing Multi-Agent Design Spec With New Priority Order

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`

- [ ] **Step 1: Insert priority update after section 5**

In `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`, after section `## 5. 采用方案`, insert this subsection:

```markdown
### 5.1 2026-07-23 优先级修订

在进入正式 `WorkflowRun + SharedTaskContext + ContextPatch + Gate` 实现前，先完成两个前置验证：

1. **P0：研究 Tutti agent 通信机制。** 确认 `tutti-os/tutti` 中 mention、agent session、agent start/send/wait/get、collaboration timeline、provider-native child sessions 的通信边界，形成 `/Users/sudai/Documents/Mate Agent/docs/research/tutti-agent-communication.md`。
2. **P1：shared file 双 Agent POC。** 在 Mate Agent 项目根目录用 `task.md`、`plan.md` 和 `.collab-poc/events.jsonl` 验证 Hermes 与 Codex 在不同进程、执行后断开的情况下，仍能通过文件系统恢复对方状态。

这两个前置步骤不改变 Mate Agent runtime，不引入 Redis，不新增 HTTP server，也不新增 CLI spawn path。它们只验证通信介质和协作纪律是否可用。验证通过后，再把 shared file POC 的成功经验抽象进正式 `WorkflowRun` 和 `SharedTaskContext`。
```

- [ ] **Step 2: Verify the spec mentions the new priority**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
grep -n "P0：研究 Tutti\|P1：shared file" docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md
```

Expected: two matching lines.

---

## Task 6: Final Verification

**Files:**
- Read-only verification of files created or modified by Tasks 1-5.

- [ ] **Step 1: Confirm Git only shows intended tracked changes**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
git status --short
```

Expected tracked changes include:

```text
 M .gitignore
 M docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md
?? docs/research/tutti-agent-communication.md
?? docs/superpowers/plans/2026-07-23-mate-agent-tutti-shared-file-collaboration-poc.md
```

Expected local POC files are ignored and do not appear:

```text
task.md
plan.md
.collab-poc/
```

- [ ] **Step 2: Verify ignored local state exists**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
test -f task.md && echo task-ok
test -f plan.md && echo plan-ok
test -f .collab-poc/events.jsonl && echo events-ok
test -f .collab-poc/README.md && echo readme-ok
```

Expected:

```text
task-ok
plan-ok
events-ok
readme-ok
```

- [ ] **Step 3: Verify event sequence**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
python3 - <<'PY'
import json
from pathlib import Path
p = Path('.collab-poc/events.jsonl')
events = [json.loads(line) for line in p.read_text(encoding='utf-8').splitlines() if line.strip()]
print([event['type'] for event in events])
assert [event['type'] for event in events] == ['initialized', 'hermes.proposal', 'codex.review']
PY
```

Expected:

```text
['initialized', 'hermes.proposal', 'codex.review']
```

- [ ] **Step 4: Run the repository test command only if runtime code was changed**

Because this POC changes docs and ignored local shared files only, `npm test` is not required for this POC. If any implementation step accidentally changes `/Users/sudai/Documents/Mate Agent/src/**`, run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm test
```

Expected: test suite passes.

---

## Implementation Notes

- This plan intentionally does not create production `WorkflowRun` code.
- `task.md`, `plan.md`, and `.collab-poc/` are local POC state and should remain ignored.
- The append-only `events.jsonl` is the durable state source for the POC.
- The markdown files are readable snapshots for humans and agents.
- If the POC works, the next implementation plan should convert this shape into per-conversation `WorkflowRun`, `SharedTaskContext`, `ContextPatch`, and `Gate` objects under Mate Agent's normal data root.
