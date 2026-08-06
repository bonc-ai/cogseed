import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import * as paths from '../../../../src/main/paths';
import { evaluateWake } from '../../../../src/main/features/p3394/wake-service';
import { decideWakeRequest } from '../../../../src/main/features/p3394/wake-controller';

const UID = 'wake-domain-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

it('routes an approved Mate wake through an injected dispatcher without Group Chat enqueue', async () => {
  const pending = await evaluateWake(UID, { conversationId: 'mate-coord-domain', executionDomain: 'mate', executionScopeId: 'mate-coord-domain', agentId: 'agent-1', agentName: 'Agent', source: 'dispatch_to', sourceActorId: 'parent', objective: 'continue', dispatchPayload: { text: 'continue' } });
  expect(pending.approved).toBe(false); if (pending.approved) return;
  const dispatcher = { dispatch: vi.fn(async () => {}) };
  const result = await decideWakeRequest(UID, { requestId: pending.request.id, decision: 'approve' }, { dispatcher, validateTarget: async () => true });
  expect(result).toMatchObject({ ok: true, dispatched: true });
  expect(dispatcher.dispatch).toHaveBeenCalledWith(UID, expect.objectContaining({ execution_domain: 'mate', execution_scope_id: 'mate-coord-domain' }), expect.anything());
});
