# Shared Collaboration POC — Results

**Run ID**: collab-poc-2026-07-23-001  
**Status**: ✅ Completed  
**Date**: 2026-07-27

## Objective

Validate whether Hermes and Codex can collaborate across separate short-lived processes by reading and writing shared files.

## Result Summary

**SUCCESS** — The POC confirmed that append-only event files plus markdown state snapshots provide sufficient continuity for multi-agent collaboration across process boundaries.

## What Was Tested

1. **Durable state bridge** — Both agents read and wrote to shared files (`task.md`, `plan.md`, `events.jsonl`) without requiring Redis, HTTP servers, or runtime code changes.

2. **Process boundary survival** — All agent state (3 events: system init, hermes proposal, codex review) persisted to disk and was successfully reconstructed in a fresh process.

3. **Append-only event ledger** — `.collab-poc/events.jsonl` served as the source of truth; markdown files served as human-readable snapshots.

## Key Findings

### ✅ What Worked

- **Direct file reads/writes are sufficient** — No helper command or orchestration service was needed.
- **Append-only events provided continuity** — Each agent appended one JSONL event describing its understanding; later agents could reconstruct the full collaboration history.
- **Markdown snapshots aided human readability** — `task.md` and `plan.md` gave humans a quick view of current state without parsing JSONL.
- **Process boundaries did not cause state loss** — All 3 events survived across separate agent invocations.

### ⚠️ Open Design Questions

1. **What fields are required for production?**
   - POC used: `ts`, `agent`, `type`, `summary`, `next`
   - Production may need: `run_id`, `phase`, `blocking_deps`, `error_state`, `retry_count`

2. **How should conflicts be resolved?**
   - POC had sequential writes; concurrent writes to markdown snapshots could conflict.
   - Options: file locks, CRDTs, event-sourcing with projections, or coordinator process.

3. **When should snapshots be rebuilt?**
   - POC manually updated `task.md` after each event.
   - Production could auto-generate snapshots from events, or use snapshots as optimization only.

4. **Does this scale beyond 2 agents?**
   - POC validated 2-agent (Hermes ↔ Codex) collaboration.
   - 3+ agents may need explicit turn-taking or a coordination layer.

## Event Log

```jsonl
{"ts":"2026-07-23T00:00:00Z","agent":"system","type":"initialized","summary":"Shared collaboration POC initialized.","next":"Hermes writes first proposal."}
{"ts":"2026-07-23T00:01:00Z","agent":"hermes","type":"hermes.proposal","summary":"Hermes confirms shared files are sufficient for a first durable state bridge because later processes can recover from disk.","next":"Codex reviews whether append-only events plus markdown snapshots avoid state loss."}
{"ts":"2026-07-23T00:02:00Z","agent":"codex","type":"codex.review","summary":"Codex agrees with the POC but requires append-only events to be treated as the source of truth and markdown files as snapshots.","next":"Final readback verifies both agent updates survive process boundaries."}
{"ts":"2026-07-27T08:15:00Z","agent":"codex","type":"final.readback","summary":"Codex performed final readback: task.md shows phase=poc_complete, events.jsonl contains 3 prior events (system init, hermes proposal, codex review), plan.md has 6 steps with step 1-5 implicit completion and step 6 now executing. Both Hermes and Codex state survived process boundaries.","next":"Mark POC complete and update task.md with final status."}
```

## Recommended Next Steps

1. **Formalize the event schema** — Define required fields, event types, and versioning strategy for production WorkflowRun/SharedTaskContext.

2. **Add conflict resolution** — Design a strategy for concurrent writes (file locks, event sourcing, or coordinator process).

3. **Test with 3+ agents** — Validate that the shared-file protocol scales beyond 2-agent collaboration.

4. **Automate snapshot generation** — Consider generating `task.md`/`plan.md` from events rather than manual updates.

5. **Integrate with Mate Agent runtime** — Wire the shared-file protocol into the existing group chat bus and agent dispatch system.

## Conclusion

The POC successfully demonstrated that **shared files provide a viable durable state bridge** for multi-agent collaboration across process boundaries. Append-only events plus markdown snapshots avoided state loss, required no infrastructure changes, and survived process restarts.

This validates the core hypothesis and provides a foundation for formal WorkflowRun/SharedTaskContext implementation in the Mate Agent runtime.
