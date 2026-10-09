import type { CollaborationStore, CollaborationScope } from '../collaboration_control/ports';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../collaboration_control/types';

export interface GroupChatCollaborationStoreDeps {
  withConversationLock<T>(uid: string, cid: string, fn: () => Promise<T>): Promise<T>;
  readRun(uid: string, cid: string, runId: string): Promise<WorkflowRun | null>;
  writeRun(uid: string, cid: string, run: WorkflowRun): Promise<void>;
  readContext(uid: string, cid: string, contextId: string): Promise<SharedTaskContext | null>;
  writeContext(uid: string, cid: string, context: SharedTaskContext): Promise<void>;
  appendEvent(uid: string, cid: string, event: CollaborationEvent): Promise<void>;
  readEvents(uid: string, cid: string, afterSequence?: number, limit?: number): Promise<CollaborationEvent[]>;
}

function groupScope(scope: CollaborationScope): void {
  if (scope.domain !== 'group_chat') throw new Error('Group Chat collaboration store requires group_chat domain');
}

export function createGroupChatCollaborationStore(deps: GroupChatCollaborationStoreDeps): CollaborationStore {
  return {
    withLock(scope, fn) { groupScope(scope); return deps.withConversationLock(scope.ownerId, scope.scopeId, fn); },
    readRun(scope, runId) { groupScope(scope); return deps.readRun(scope.ownerId, scope.scopeId, runId); },
    writeRun(scope, run) { groupScope(scope); return deps.writeRun(scope.ownerId, scope.scopeId, run); },
    readContext(scope, contextId) { groupScope(scope); return deps.readContext(scope.ownerId, scope.scopeId, contextId); },
    writeContext(scope, context) { groupScope(scope); return deps.writeContext(scope.ownerId, scope.scopeId, context); },
    appendEvent(scope, event) { groupScope(scope); return deps.appendEvent(scope.ownerId, scope.scopeId, event); },
    readEvents(scope, afterSequence, limit) { groupScope(scope); return deps.readEvents(scope.ownerId, scope.scopeId, afterSequence, limit); },
  };
}
