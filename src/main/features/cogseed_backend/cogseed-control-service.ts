import { createCollaborationEngine } from '../collaboration_control/engine';
import { createCogSeedCollaborationStore } from './collaboration-store-adapter';
import { createCogSeedCollaborationDispatcher } from './collaboration-dispatcher';
import { readCogSeedCoordination } from './coordinator';
import type { ResumeCogSeedTaskInput, StartCogSeedTaskInput } from './runtime-controller';
import {
  getOrCreateCogSeedCommanderSession,
  getOrCreateCogSeedMemberSession,
  joinCogSeedMember,
  leaveCogSeedMember,
  readCogSeedRoster,
  readCogSeedSession,
  renameCogSeedMember,
} from './session-store';
import type { CogSeedActorRole } from './types';
import { readCogSeedTaskByRequestId } from './task-store';

async function runtimeController() { return (await import('./runtime-controller')).cogseedRuntimeController; }
function engine() { return createCollaborationEngine({ store: createCogSeedCollaborationStore(), dispatcher: createCogSeedCollaborationDispatcher({ startTask: async (uid, input) => (await runtimeController()).startCogSeedTask(uid, input), cancelTask: async (uid, taskId) => (await runtimeController()).cancelCogSeedTask(uid, taskId) }) }); }
async function scopeFor(userId: string, parentRequestId: string) {
  const parent = await readCogSeedTaskByRequestId(userId, parentRequestId); if (!parent) throw new Error('CogSeed control parent task not found');
  const coordinationId = `cogseed-coord-${parent.taskId.slice('cogseed-task-'.length)}`; const record = await readCogSeedCoordination(userId, coordinationId); if (!record?.workflowRunId) throw new Error('CogSeed workflow not found');
  return { scope: { ownerId: userId, domain: 'cogseed' as const, scopeId: coordinationId }, runId: record.workflowRunId };
}
async function scopeForCoordination(userId: string, coordinationId: string) {
  const record = await readCogSeedCoordination(userId, coordinationId);
  if (!record?.workflowRunId) throw new Error('CogSeed workflow not found');
  return { scope: { ownerId: userId, domain: 'cogseed' as const, scopeId: record.coordinationId }, runId: record.workflowRunId };
}

export interface StartCogSeedCommanderTaskInput extends Omit<StartCogSeedTaskInput, 'sessionId'> {
  conversationId: string;
}

export interface StartCogSeedMemberTaskInput extends Omit<StartCogSeedTaskInput, 'sessionId'> {
  conversationId: string;
  actorId: string;
  displayName?: string;
  actorRole?: Exclude<CogSeedActorRole, 'commander'>;
}

export const cogseedControlService = {
  async retryStep(userId: string, parentRequestId: string, stepId: string) { const found = await scopeFor(userId, parentRequestId); const retried = await engine().retryStep(found.scope, found.runId, stepId); return engine().startStep(found.scope, found.runId, retried.step.id); },
  async skipStep(userId: string, parentRequestId: string, stepId: string, reason?: string) { const found = await scopeFor(userId, parentRequestId); return engine().skipStep(found.scope, found.runId, stepId, reason); },
  async resume(userId: string, parentRequestId: string, reason?: string) { const found = await scopeFor(userId, parentRequestId); return engine().resumeRun(found.scope, found.runId, reason); },
  async workflow(userId: string, parentRequestId: string) { const found = await scopeFor(userId, parentRequestId); return createCogSeedCollaborationStore().readRun(found.scope, found.runId); },
  async retryCoordinationStep(userId: string, coordinationId: string, stepId: string) { const found = await scopeForCoordination(userId, coordinationId); const retried = await engine().retryStep(found.scope, found.runId, stepId); return engine().startStep(found.scope, found.runId, retried.step.id); },
  async skipCoordinationStep(userId: string, coordinationId: string, stepId: string, reason?: string) { const found = await scopeForCoordination(userId, coordinationId); return engine().skipStep(found.scope, found.runId, stepId, reason); },
  async reviewCoordinationGate(userId: string, coordinationId: string, gateId: string, decision: 'approve' | 'reject', reason?: string) { const found = await scopeForCoordination(userId, coordinationId); return engine().reviewGate(found.scope, found.runId, gateId, decision, reason); },
  async dismissCoordinationConflict(userId: string, coordinationId: string, conflictId: string, reason?: string) { const found = await scopeForCoordination(userId, coordinationId); return engine().dismissConflict(found.scope, found.runId, conflictId, reason); },

  async session(userId: string, sessionId: string) {
    return readCogSeedSession(userId, sessionId);
  },

  async commanderSession(userId: string, conversationId: string) {
    return getOrCreateCogSeedCommanderSession(userId, conversationId);
  },

  async memberSession(
    userId: string,
    conversationId: string,
    actorId: string,
    displayName?: string,
    actorRole?: Exclude<CogSeedActorRole, 'commander'>,
  ) {
    return getOrCreateCogSeedMemberSession(userId, conversationId, actorId, displayName, actorRole);
  },

  async joinMember(
    userId: string,
    conversationId: string,
    actorId: string,
    displayName?: string,
    actorRole?: Exclude<CogSeedActorRole, 'commander'>,
  ) {
    return joinCogSeedMember(userId, conversationId, actorId, displayName, actorRole);
  },

  async leaveMember(userId: string, conversationOrSessionId: string, actorId: string) {
    return leaveCogSeedMember(userId, conversationOrSessionId, actorId);
  },

  async renameMember(userId: string, conversationOrSessionId: string, actorId: string, displayName: string) {
    return renameCogSeedMember(userId, conversationOrSessionId, actorId, displayName);
  },

  async roster(userId: string, conversationOrSessionId: string) {
    return readCogSeedRoster(userId, conversationOrSessionId);
  },

  async startCommanderTask(userId: string, input: StartCogSeedCommanderTaskInput) {
    const session = await getOrCreateCogSeedCommanderSession(userId, input.conversationId);
    const { conversationId, ...taskInput } = input;
    return (await runtimeController()).startCogSeedTask(userId, { ...taskInput, sessionId: session.sessionId, conversationId });
  },

  async startMemberTask(userId: string, input: StartCogSeedMemberTaskInput) {
    const session = await getOrCreateCogSeedMemberSession(
      userId,
      input.conversationId,
      input.actorId,
      input.displayName,
      input.actorRole,
    );
    const { conversationId, actorId: _actorId, displayName: _displayName, actorRole: _actorRole, ...taskInput } = input;
    return (await runtimeController()).startCogSeedTask(userId, { ...taskInput, sessionId: session.sessionId, conversationId });
  },

  async resumeTask(userId: string, taskId: string, input: ResumeCogSeedTaskInput) {
    return (await runtimeController()).resumeCogSeedTask(userId, taskId, input);
  },

  async abortTask(userId: string, taskId: string) {
    return (await runtimeController()).cancelCogSeedTask(userId, taskId);
  },
};
