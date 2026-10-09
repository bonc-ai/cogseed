import { nowIso } from '../../../../storage';
import { buildResourceKey, type ExternalResource, type ResourceCapability } from '../../contract';
import { boundedEvidence, type NormalizedContent } from './types';

export interface CalendarContentInput {
  tenant: string;
  unionId: string;
  calendarId: string;
  event: {
    id: string;
    summary: string;
    startTime: string;
    endTime: string;
    description?: string;
    location?: string;
    updatedAt?: string;
    sourceUrl?: string;
  };
}

const CAPABILITY: ResourceCapability = Object.freeze({
  canList: true,
  canReadMetadata: true,
  canReadContent: true,
  canSyncIncrementally: true,
  canGenerateCandidates: true,
});

export function normalizeCalendarContent(input: CalendarContentInput): NormalizedContent {
  if (!input.tenant || !input.unionId || !input.calendarId || !input.event.id) {
    throw new Error('calendar content requires tenant, unionId, calendarId and event id');
  }
  const resourceId = buildResourceKey('feishu', input.tenant, 'calendar_event', input.event.id);
  const details = [
    input.event.summary,
    `${input.event.startTime} - ${input.event.endTime}`,
    input.event.location ? `地点：${input.event.location}` : '',
    input.event.description || '',
  ].filter(Boolean);
  const text = details.join('\n');
  const resource: ExternalResource = {
    resourceId,
    resourceType: 'calendar_event',
    sourceVersion: input.event.updatedAt || input.event.id,
    title: input.event.summary || input.event.id,
    ownerRef: `feishu:union_id:${input.unionId}`,
    containerRef: buildResourceKey('feishu', input.tenant, 'calendar', input.calendarId),
    sourceUrl: input.event.sourceUrl,
    observedAt: nowIso(),
    accessLabel: 'personal',
    retentionPolicy: 'source-linked',
    bodyLoaded: true,
    capability: CAPABILITY,
    contentStatus: 'loaded',
    sourceValidity: 'active',
  };
  return {
    resource,
    version: resource.sourceVersion || input.event.id,
    title: resource.title,
    text,
    evidence: [{
      sourceResourceId: resourceId,
      excerpt: boundedEvidence(text),
      ...(input.event.sourceUrl ? { sourceUrl: input.event.sourceUrl } : {}),
      locator: `${input.event.startTime}/${input.event.endTime}`,
    }],
    warnings: text.trim() ? [] : [{ code: 'empty_content', message: 'calendar event has no readable content' }],
  };
}
