export type TraceStage = 'routing' | 'task' | 'requirement' | 'projection' | 'forecast' | 'runtime' | 'episode' | 'review' | 'extraction' | 'precipitation' | 'failure';
export type TraceStatus = 'ok' | 'pending' | 'failed' | 'degraded' | 'skipped' | 'not_started';

export interface KstarTraceNode {
  stage: TraceStage;
  status: TraceStatus;
  at?: string;
  primaryId?: string;
  parentId?: string;
  source?: string;
  summary?: string;
  errorCode?: string;
  degradedReason?: string;
}

export interface KstarTrace {
  conversationId: string;
  taskId?: string;
  nodes: KstarTraceNode[];
  generatedAt: string;
}
