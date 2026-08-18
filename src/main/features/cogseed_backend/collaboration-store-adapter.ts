import * as fs from 'node:fs/promises';
import { appendJsonlAtomic, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import type { CollaborationScope, CollaborationStore } from '../collaboration_control/ports';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../collaboration_control/types';
import { assertCogSeedCoordinationId, assertCogSeedUserId, cogseedCoordinationControlContextFile, cogseedCoordinationControlEventsFile, cogseedCoordinationControlRunFile } from './paths';

function cogseedScope(scope: CollaborationScope): { userId: string; coordinationId: string } {
  if (scope.domain !== 'cogseed') throw new Error('CogSeed collaboration store requires cogseed domain');
  return { userId: assertCogSeedUserId(scope.ownerId), coordinationId: assertCogSeedCoordinationId(scope.scopeId) };
}
async function readFile<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

export function createCogSeedCollaborationStore(): CollaborationStore {
  return {
    withLock(scope, fn) { const s = cogseedScope(scope); return fileEditLock(cogseedCoordinationControlRunFile(s.userId, s.coordinationId)).runExclusive(fn); },
    readRun(scope, runId) { const s = cogseedScope(scope); return readFile<WorkflowRun>(cogseedCoordinationControlRunFile(s.userId, s.coordinationId)).then((run) => run?.id === runId && run.cid === s.coordinationId ? run : null); },
    writeRun(scope, run) { const s = cogseedScope(scope); if (run.cid !== s.coordinationId) throw new Error('CogSeed collaboration run scope mismatch'); return writeJson(cogseedCoordinationControlRunFile(s.userId, s.coordinationId), run); },
    readContext(scope, contextId) { const s = cogseedScope(scope); return readFile<SharedTaskContext>(cogseedCoordinationControlContextFile(s.userId, s.coordinationId)).then((context) => context?.id === contextId && context.cid === s.coordinationId ? context : null); },
    writeContext(scope, context) { const s = cogseedScope(scope); if (context.cid !== s.coordinationId) throw new Error('CogSeed collaboration context scope mismatch'); return writeJson(cogseedCoordinationControlContextFile(s.userId, s.coordinationId), context); },
    async appendEvent(scope, event) { const s = cogseedScope(scope); if (event.cid !== s.coordinationId) throw new Error('CogSeed collaboration event scope mismatch'); await appendJsonlAtomic(cogseedCoordinationControlEventsFile(s.userId, s.coordinationId), event); },
    async readEvents(scope, _afterSequence = 0, limit = 200) { const s = cogseedScope(scope); try { const lines = (await fs.readFile(cogseedCoordinationControlEventsFile(s.userId, s.coordinationId), 'utf8')).split(/\r?\n/).filter(Boolean); return lines.slice(-Math.max(1, Math.min(limit, 500))).map((line) => JSON.parse(line) as CollaborationEvent); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; } },
  };
}
export const cogseedCollaborationStore = createCogSeedCollaborationStore();
