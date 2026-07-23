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

The POC succeeds if:

1. Hermes can read the shared files, append its state, and exit.
2. Codex can read Hermes's persisted state, append review or next-step state, and exit.
3. A later Hermes or Codex run can recover the whole collaboration state from disk.
4. The append-only event log preserves both agents' updates.
5. No Mate Agent runtime code needs to change for the POC.

