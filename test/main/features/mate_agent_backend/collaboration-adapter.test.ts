import * as fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import * as paths from '../../../../src/main/paths';
import { createMateCollaborationStore } from '../../../../src/main/features/mate_agent_backend/collaboration-store-adapter';

const UID = 'mate-collab-store-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

it('persists control-plane state only inside the Mate coordination domain', async () => {
  const store = createMateCollaborationStore(); const scope = { ownerId: UID, domain: 'mate' as const, scopeId: 'mate-coord-test' };
  const run: any = { version: 1, id: 'run-1', cid: scope.scopeId, objective: 'x', kind: 'custom', status: 'running', phase: 'x', steps: [], context_id: 'ctx-1', created_by: 'mate', created_at: 't', updated_at: 't' };
  const context: any = { version: 1, id: 'ctx-1', cid: scope.scopeId, run_id: 'run-1', objective: 'x', phase: 'x', revision: 1, constraints: [], facts: [], decisions: [], open_questions: [], risks: [], artifacts: [], agent_outputs: {}, gates: [], proposals: [], conflicts: [], updated_at: 't' };
  await store.withLock(scope, async () => { await store.writeRun(scope, run); await store.writeContext(scope, context); await store.appendEvent(scope, { version: 1, id: 'e1', cid: scope.scopeId, run_id: 'run-1', type: 'workflow_created', created_at: 't' }); });
  await expect(store.readRun(scope, 'run-1')).resolves.toMatchObject({ id: 'run-1' }); await expect(store.readEvents(scope)).resolves.toHaveLength(1);
  expect(fs.existsSync(paths.mateAgentCoordinationsDir(UID))).toBe(true);
  expect(fs.existsSync(paths.groupChatDir(UID, scope.scopeId))).toBe(false);
});
