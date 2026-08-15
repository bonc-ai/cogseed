import * as fs from 'node:fs/promises';
import { appendJsonlAtomic, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import type { CollaborationScope, CollaborationStore } from '../collaboration_control/ports';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../collaboration_control/types';
import { assertMateCoordinationId, assertMateUserId, mateCoordinationControlContextFile, mateCoordinationControlEventsFile, mateCoordinationControlRunFile } from './paths';

function mateScope(scope: CollaborationScope): { userId: string; coordinationId: string } {
  if (scope.domain !== 'mate') throw new Error('CogSeed collaboration store requires mate domain');
  return { userId: assertMateUserId(scope.ownerId), coordinationId: assertMateCoordinationId(scope.scopeId) };
}
async function readFile<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

export function createMateCollaborationStore(): CollaborationStore {
  return {
    withLock(scope, fn) { const s = mateScope(scope); return fileEditLock(mateCoordinationControlRunFile(s.userId, s.coordinationId)).runExclusive(fn); },
    readRun(scope, runId) { const s = mateScope(scope); return readFile<WorkflowRun>(mateCoordinationControlRunFile(s.userId, s.coordinationId)).then((run) => run?.id === runId && run.cid === s.coordinationId ? run : null); },
    writeRun(scope, run) { const s = mateScope(scope); if (run.cid !== s.coordinationId) throw new Error('CogSeed collaboration run scope mismatch'); return writeJson(mateCoordinationControlRunFile(s.userId, s.coordinationId), run); },
    readContext(scope, contextId) { const s = mateScope(scope); return readFile<SharedTaskContext>(mateCoordinationControlContextFile(s.userId, s.coordinationId)).then((context) => context?.id === contextId && context.cid === s.coordinationId ? context : null); },
    writeContext(scope, context) { const s = mateScope(scope); if (context.cid !== s.coordinationId) throw new Error('CogSeed collaboration context scope mismatch'); return writeJson(mateCoordinationControlContextFile(s.userId, s.coordinationId), context); },
    async appendEvent(scope, event) { const s = mateScope(scope); if (event.cid !== s.coordinationId) throw new Error('CogSeed collaboration event scope mismatch'); await appendJsonlAtomic(mateCoordinationControlEventsFile(s.userId, s.coordinationId), event); },
    async readEvents(scope, _afterSequence = 0, limit = 200) { const s = mateScope(scope); try { const lines = (await fs.readFile(mateCoordinationControlEventsFile(s.userId, s.coordinationId), 'utf8')).split(/\r?\n/).filter(Boolean); return lines.slice(-Math.max(1, Math.min(limit, 500))).map((line) => JSON.parse(line) as CollaborationEvent); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; } },
  };
}
export const mateCollaborationStore = createMateCollaborationStore();
