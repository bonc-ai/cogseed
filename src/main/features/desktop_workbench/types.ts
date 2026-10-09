import type { PersonalContextDashboard } from '../personal_context/application/types';
import type { ReviewItemView } from '../personal_context/application';
import type { TouchpointIntent } from '../touchpoints/types';

export type WorkbenchAttentionKind = 'feishu_not_connected' | 'resource_authorization_required' | 'sync_partial' | 'review_pending' | 'briefing_ready';
export type WorkbenchSeverity = 'info' | 'warning' | 'critical';

export interface WorkbenchAttentionItem {
  id: string;
  kind: WorkbenchAttentionKind;
  severity: WorkbenchSeverity;
  title: string;
  detail: string;
  action?: string;
}

export interface WorkbenchTimelineItem {
  id: string;
  title: string;
  channel: 'desktop' | 'feishu';
  state: 'planned' | 'ready' | 'sending' | 'sent' | 'retry_pending';
  scheduledAt: string;
  expiresAt: string;
  priority: TouchpointIntent['priority'];
}

export interface WorkbenchDecisionItem {
  id: string;
  kind: 'ontology_confirmation';
  title: string;
  detail: string;
  confidence: string;
  sourceRefs: string[];
}

export interface WorkbenchRunningItem {
  id: string;
  state: 'sending' | 'retry_pending';
  title: string;
  detail: string;
  attempts: number;
  channel: 'feishu';
}

export interface WorkbenchTouchpointSummary {
  channel: 'feishu';
  connected: boolean;
  ownerBound: boolean;
  realMode: boolean;
  instanceId: string | null;
  lastError?: string;
}

export interface DesktopWorkbenchProjection {
  version: 1;
  generatedAt: string;
  mode: PersonalContextDashboard['mode'];
  sections: {
    attention: WorkbenchAttentionItem[];
    timeline: WorkbenchTimelineItem[];
    decisions: WorkbenchDecisionItem[];
    running: WorkbenchRunningItem[];
  };
  touchpoints: WorkbenchTouchpointSummary[];
}

export interface DesktopWorkbenchProjectionInput {
  dashboard: PersonalContextDashboard;
  reviewItems: ReviewItemView[];
  intents: TouchpointIntent[];
  generatedAt: string;
}
