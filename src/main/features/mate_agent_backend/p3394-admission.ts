import { P3394Controller } from '../p3394/controller';
import { EpochStore } from '../p3394/epoch-store';
import { listMateSessions } from './session-store';
import { readMateCoordination } from './coordinator';
import { createMateCollaborationStore } from './collaboration-store-adapter';

export function createMateP3394Controller(): P3394Controller {
  return new P3394Controller({
    sessionSource: { async resolve(userId, sessionId) { const sessions = await listMateSessions(userId); const match = sessions.find((item) => item.sessionId === sessionId || item.runtimeSessionId === sessionId); return { sessionId, kind: match ? 'mate-agent' : null, region: 'local', valid: !!match }; } },
    epochStore: new EpochStore(),
    contextSource: { async snapshot(userId, coordinationId) { const coordination = await readMateCoordination(userId, coordinationId); if (!coordination?.workflowRunId) return null; const scope = { ownerId: userId, domain: 'mate' as const, scopeId: coordinationId }; const run = await createMateCollaborationStore().readRun(scope, coordination.workflowRunId); return run ? { context_id: run.context_id, status: run.status } : null; } },
  });
}
export const mateP3394Controller = createMateP3394Controller();
