import { createCollaborationEngine } from '../collaboration_control/engine';
import { createMateCollaborationStore } from './collaboration-store-adapter';
import { createMateCollaborationDispatcher } from './collaboration-dispatcher';
import { readMateCoordination } from './coordinator';
import type { ResumeMateTaskInput, StartMateTaskInput } from './runtime-controller';
import {
  getOrCreateMateCommanderSession,
  getOrCreateMateMemberSession,
  joinMateMember,
  leaveMateMember,
  readMateRoster,
  readMateSession,
  renameMateMember,
} from './session-store';
import type { MateActorRole } from './types';
import { readMateTaskByRequestId } from './task-store';

async function runtimeController() { return (await import('./runtime-controller')).mateRuntimeController; }
function engine() { return createCollaborationEngine({ store: createMateCollaborationStore(), dispatcher: createMateCollaborationDispatcher({ startTask: async (uid, input) => (await runtimeController()).startMateTask(uid, input), cancelTask: async (uid, taskId) => (await runtimeController()).cancelMateTask(uid, taskId) }) }); }
async function scopeFor(userId: string, parentRequestId: string) {
  const parent = await readMateTaskByRequestId(userId, parentRequestId); if (!parent) throw new Error('CogSeed control parent task not found');
  const coordinationId = `mate-coord-${parent.taskId.slice('mate-task-'.length)}`; const record = await readMateCoordination(userId, coordinationId); if (!record?.workflowRunId) throw new Error('CogSeed workflow not found');
  return { scope: { ownerId: userId, domain: 'mate' as const, scopeId: coordinationId }, runId: record.workflowRunId };
}

export interface StartMateCommanderTaskInput extends Omit<StartMateTaskInput, 'sessionId'> {
  conversationId: string;
}

export interface StartMateMemberTaskInput extends Omit<StartMateTaskInput, 'sessionId'> {
  conversationId: string;
  actorId: string;
  displayName?: string;
  actorRole?: Exclude<MateActorRole, 'commander'>;
}

export const mateControlService = {
  async retryStep(userId: string, parentRequestId: string, stepId: string) { const found = await scopeFor(userId, parentRequestId); const retried = await engine().retryStep(found.scope, found.runId, stepId); return engine().startStep(found.scope, found.runId, retried.step.id); },
  async skipStep(userId: string, parentRequestId: string, stepId: string, reason?: string) { const found = await scopeFor(userId, parentRequestId); return engine().skipStep(found.scope, found.runId, stepId, reason); },
  async resume(userId: string, parentRequestId: string, reason?: string) { const found = await scopeFor(userId, parentRequestId); return engine().resumeRun(found.scope, found.runId, reason); },
  async workflow(userId: string, parentRequestId: string) { const found = await scopeFor(userId, parentRequestId); return createMateCollaborationStore().readRun(found.scope, found.runId); },

  async session(userId: string, sessionId: string) {
    return readMateSession(userId, sessionId);
  },

  async commanderSession(userId: string, conversationId: string) {
    return getOrCreateMateCommanderSession(userId, conversationId);
  },

  async memberSession(
    userId: string,
    conversationId: string,
    actorId: string,
    displayName?: string,
    actorRole?: Exclude<MateActorRole, 'commander'>,
  ) {
    return getOrCreateMateMemberSession(userId, conversationId, actorId, displayName, actorRole);
  },

  async joinMember(
    userId: string,
    conversationId: string,
    actorId: string,
    displayName?: string,
    actorRole?: Exclude<MateActorRole, 'commander'>,
  ) {
    return joinMateMember(userId, conversationId, actorId, displayName, actorRole);
  },

  async leaveMember(userId: string, conversationOrSessionId: string, actorId: string) {
    return leaveMateMember(userId, conversationOrSessionId, actorId);
  },

  async renameMember(userId: string, conversationOrSessionId: string, actorId: string, displayName: string) {
    return renameMateMember(userId, conversationOrSessionId, actorId, displayName);
  },

  async roster(userId: string, conversationOrSessionId: string) {
    return readMateRoster(userId, conversationOrSessionId);
  },

  async startCommanderTask(userId: string, input: StartMateCommanderTaskInput) {
    const session = await getOrCreateMateCommanderSession(userId, input.conversationId);
    const { conversationId, ...taskInput } = input;
    return (await runtimeController()).startMateTask(userId, { ...taskInput, sessionId: session.sessionId, conversationId });
  },

  async startMemberTask(userId: string, input: StartMateMemberTaskInput) {
    const session = await getOrCreateMateMemberSession(
      userId,
      input.conversationId,
      input.actorId,
      input.displayName,
      input.actorRole,
    );
    const { conversationId, actorId: _actorId, displayName: _displayName, actorRole: _actorRole, ...taskInput } = input;
    return (await runtimeController()).startMateTask(userId, { ...taskInput, sessionId: session.sessionId, conversationId });
  },

  async resumeTask(userId: string, taskId: string, input: ResumeMateTaskInput) {
    return (await runtimeController()).resumeMateTask(userId, taskId, input);
  },

  async abortTask(userId: string, taskId: string) {
    return (await runtimeController()).cancelMateTask(userId, taskId);
  },
};
