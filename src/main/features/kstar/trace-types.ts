export type TraceStage = 'routing' | 'task' | 'requirement' | 'projection' | 'forecast' | 'injection' | 'usage' | 'runtime' | 'episode' | 'review' | 'extraction' | 'closure' | 'candidate' | 'precipitation' | 'trace_completeness' | 'failure';
export type TraceStatus = 'ok' | 'pending' | 'failed' | 'degraded' | 'skipped' | 'not_started';
export type TraceCompleteness = 'complete' | 'partial' | 'not_recorded' | 'degraded';

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
  completeness?: TraceCompleteness;
}

export interface KstarTrace {
  conversationId: string;
  taskId?: string;
  nodes: KstarTraceNode[];
  generatedAt: string;
}
