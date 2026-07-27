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

- [x] Step 1: Initialize shared files.
- [x] Step 2: Hermes reads all shared files and appends a `hermes.proposal` event.
- [x] Step 3: Hermes updates `task.md` Current State and Last Updates.
- [x] Step 4: Codex reads all shared files and appends a `codex.review` event.
- [x] Step 5: Codex updates `task.md` Current State, Decisions, Open Questions, and Last Updates.
- [x] Step 6: Run a final readback to confirm both agents' state survived process boundaries.

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
