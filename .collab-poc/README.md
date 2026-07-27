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
