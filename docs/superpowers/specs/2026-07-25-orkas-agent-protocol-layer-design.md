# Orkas Agent Protocol Layer Design

## Goal

Introduce a small P3394-inspired protocol layer for Mate Agent's agent runtime so Orkas can govern both in-process agents and external CLI expert agents through one interface contract.

This is not a full P3394 implementation. It is the first product slice: a local, internal contract that makes agent identity, runtime, capability, data boundary, output, and evidence expectations explicit.

## Product Position

Orkas Core Agent remains the commander, main reasoning runtime, and governance layer. External agents such as Codex, Hermes, Claude Code, OpenClaw, and OpenCode remain specialist executors. They must not become commander backends or own Mate Agent's top-level conversation session.

The protocol layer is the boundary Orkas uses to call any agent. It gives us one place to reason about:

- what kind of agent is being called,
- what capability the call is allowed to exercise,
- which conversation/turn/session the call belongs to,
- what data the agent may see,
- what output shape the caller can expect,
- what evidence should be recorded.

## Scope

In scope for the first slice:

- Add a normalized agent interface contract derived from existing `agent.json` fields.
- Persist only small declarative metadata that belongs in agent specs.
- Treat missing contract fields as a safe default derived from existing runtime and output fields.
- Make CLI-backed agents explicit `external_expert` participants.
- Make in-process agents explicit `orkas_core` participants.
- Add tests for normalization, persistence, and runtime-facing contract derivation.

Out of scope for the first slice:

- Full P3394 conformance declarations.
- HTTP/OpenAPI/MCP public P3394 endpoints.
- Cross-product discovery.
- New npm dependencies.
- Replacing `group_chat/bus.ts` execution flow.
- Changing Local Agent spawn choke points.
- Giving external CLI agents Mate Agent SkillLoader access.

## Architecture

Add an `AgentInterfaceContract` type in `src/main/features/agents.ts`, near `AgentRuntime`, because the contract is part of the normalized agent definition consumed by runtime and renderer views.

The contract has four conceptual blocks:

1. `role`: whether this agent participates as `orkas_core` or `external_expert`.
2. `runtime`: normalized execution surface derived from `Agent.runtime`.
3. `io`: what kind of input/output the agent accepts and produces.
4. `governance`: data scope, session ownership, and evidence expectations.

The runtime should derive a contract for every agent, even if `agent.json` does not contain one. This keeps legacy agents readable and avoids a migration.

## Data Model

Proposed persisted field:

```ts
interface AgentInterfaceContract {
  version: 1;
  role: 'orkas_core' | 'external_expert';
  runtime: {
    kind: 'in_process' | 'cli';
    cli?: string;
  };
  io: {
    input: 'task_message';
    output: 'final_message' | 'final_message_with_artifacts';
  };
  governance: {
    session_role: 'owner_capable' | 'participant_only';
    data_scope: 'visibility_slice' | 'visibility_slice_with_workspace';
    uses_mate_skills: boolean;
    records_process: boolean;
    records_tool_evidence: boolean;
  };
}
```

Default derivation:

- Missing or in-process runtime:
  - `role = 'orkas_core'`
  - `runtime.kind = 'in_process'`
  - `session_role = 'owner_capable'`
  - `data_scope = 'visibility_slice_with_workspace'`
  - `uses_mate_skills = true`
  - `records_process = true`
  - `records_tool_evidence = true`
- CLI runtime:
  - `role = 'external_expert'`
  - `runtime.kind = 'cli'`
  - `runtime.cli = Agent.runtime.cli`
  - `session_role = 'participant_only'`
  - `data_scope = 'visibility_slice_with_workspace'`
  - `uses_mate_skills = false`
  - `records_process = true`
  - `records_tool_evidence = true`

The persisted field is optional. When present, normalization must still reconcile it against `Agent.runtime`; a persisted contract cannot claim `runtime.kind = 'in_process'` while `Agent.runtime.kind = 'cli'`.

## Runtime Data Flow

The first slice does not change dispatch behavior. It makes existing behavior explicit:

```text
group_chat/bus
  -> get normalized Agent
  -> read Agent.interface_contract
  -> if runtime.kind == cli, dispatch through local_agents/runner.ts
  -> else dispatch through core-agent streamChatWithModel
  -> persist final/process/tool evidence under uid + cid + turn_id
```

Future work can move the request/response wrapper into a dedicated adapter module after this contract exists.

## Security And Ownership

The contract preserves Mate Agent's current data boundaries:

- Feature functions handling user-private data still take `userId` first.
- External CLI agents remain child processes launched only through `features/local_agents/runner.ts`.
- CLI agents do not receive Mate Agent SkillLoader access.
- Agent workers continue reading only their visibility slice, not full conversation jsonl.
- File access stays bounded by active workspace plus current attachment/resource roots.
- Top-level session ownership remains with Orkas/group chat; CLI agents are participants.

## Error Handling

Invalid contract data should not break agent loading. Normalization should fall back to the derived default and log a warning only if the data is structurally present but contradictory. Unknown values are ignored.

When updating an agent, the contract should be re-derived after runtime changes. Runtime kind switches are already constrained by existing agent update rules; the contract must follow those rules rather than introducing another source of truth.

## Testing

Add focused tests around `src/main/features/agents.ts`:

- legacy in-process agents derive an Orkas Core contract,
- CLI agents derive an external expert contract and do not use Mate skills,
- malformed persisted contract is ignored in favor of runtime-derived defaults,
- runtime updates keep the contract reconciled,
- persisted valid contract survives read/write only for allowed fields.

Add a small group chat test only if runtime code starts consuming the contract directly in this slice. Otherwise keep bus behavior unchanged and avoid broad integration churn.

## Non-Goals And Traps

- Do not add Hermes commander support back through the protocol layer.
- Do not expose external CLI internals as Mate Agent skills.
- Do not add HTTP server or public P3394 endpoint.
- Do not encode `project_id` or `uid` into session ids.
- Do not duplicate the full P3394 schema inside prompts.
- Do not move CLI spawning out of `features/local_agents/runner.ts`.

## Success Criteria

- Every loaded agent has a normalized interface contract.
- Existing agents work without migration.
- CLI expert agents are explicitly marked as participant-only external experts.
- Orkas in-process agents are explicitly marked as owner-capable Orkas Core agents.
- Tests prove the contract cannot contradict the runtime backend.
