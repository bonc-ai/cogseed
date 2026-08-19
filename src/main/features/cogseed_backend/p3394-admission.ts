import { P3394Controller } from '../p3394/controller';
import { EpochStore } from '../p3394/epoch-store';
import { listCogSeedSessions } from './session-store';
import { readCogSeedCoordination } from './coordinator';
import { createCogSeedCollaborationStore } from './collaboration-store-adapter';

export function createCogSeedP3394Controller(): P3394Controller {
  return new P3394Controller({
    sessionSource: { async resolve(userId, sessionId) { const sessions = await listCogSeedSessions(userId); const match = sessions.find((item) => item.sessionId === sessionId || item.runtimeSessionId === sessionId); return { sessionId, kind: match ? 'cogseed-agent' : null, region: 'local', valid: !!match }; } },
    epochStore: new EpochStore(),
    contextSource: { async snapshot(userId, coordinationId) { const coordination = await readCogSeedCoordination(userId, coordinationId); if (!coordination?.workflowRunId) return null; const scope = { ownerId: userId, domain: 'cogseed' as const, scopeId: coordinationId }; const run = await createCogSeedCollaborationStore().readRun(scope, coordination.workflowRunId); return run ? { context_id: run.context_id, status: run.status } : null; } },
  });
}
export const cogseedP3394Controller = createCogSeedP3394Controller();
