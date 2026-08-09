import type { CollaborationEvent } from './types';

export interface CollaborationEventReplay {
  lastEventId?: string;
  completedStepIds: string[];
  skippedStepIds: string[];
  blockingGateId?: string;
  aborted: boolean;
}

export function replayCollaborationEventState(events: readonly CollaborationEvent[]): CollaborationEventReplay {
  const completed = new Set<string>(); const skipped = new Set<string>();
  const replay: CollaborationEventReplay = { completedStepIds: [], skippedStepIds: [], aborted: false };
  for (const event of events) {
    replay.lastEventId = event.id;
    if (event.type === 'step_completed' && event.step_id) completed.add(event.step_id);
    if (event.type === 'step_skipped' && event.step_id) skipped.add(event.step_id);
    if (event.type === 'gate_recorded' && event.gate_id && (event.payload?.status === 'needs_review' || event.payload?.status === 'failed')) replay.blockingGateId = event.gate_id;
    if (event.type === 'gate_reviewed' && event.gate_id === replay.blockingGateId && event.payload?.decision === 'approved') delete replay.blockingGateId;
    if (event.type === 'workflow_aborted') replay.aborted = true;
  }
  replay.completedStepIds = [...completed]; replay.skippedStepIds = [...skipped]; return replay;
}
