import { createHash } from 'node:crypto';
import { nowIso } from '../../../../storage';
import { buildResourceKey, type ExternalResource, type ResourceCapability, type ResourceType } from '../../contract';
import { boundedEvidence, type NormalizedContent } from './types';

export interface DriveContentInput {
  tenant: string;
  unionId: string;
  file: {
    id: string;
    name: string;
    type: 'file' | 'folder' | 'doc' | 'docx' | 'sheet' | 'bitable';
    updatedAt: string;
    mimeType?: string;
    parentId?: string;
    sourceUrl?: string;
  };
  body?: string;
}

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/markdown'];
const EXTRACTABLE_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.xlsx', '.md', '.txt', '.csv', '.json'];

function resourceType(input: DriveContentInput['file']): ResourceType {
  if (input.type === 'folder') return 'folder';
  if (input.type === 'doc' || input.type === 'docx' || input.type === 'sheet' || input.type === 'bitable') return 'document';
  return 'file';
}

function canReadBody(input: DriveContentInput): boolean {
  if (typeof input.body === 'string') return true;
  const mime = String(input.file.mimeType || '').toLowerCase();
  if (TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  const lower = input.file.name.toLowerCase();
  return EXTRACTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function capability(input: DriveContentInput, readable: boolean): ResourceCapability {
  return {
    canList: true,
    canReadMetadata: true,
    canReadContent: readable,
    canSyncIncrementally: true,
    canGenerateCandidates: readable,
    ...(!readable ? { unsupportedReason: `unsupported content type: ${input.file.mimeType || input.file.type}` } : {}),
  };
}

export function normalizeDriveFileContent(input: DriveContentInput): NormalizedContent {
  if (!input.tenant || !input.unionId || !input.file.id || !input.file.name || !input.file.updatedAt) {
    throw new Error('drive content requires tenant, unionId, file id, name and updatedAt');
  }
  const type = resourceType(input.file);
  const readable = canReadBody(input);
  const resourceId = buildResourceKey('feishu', input.tenant, type, input.file.id);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const resource: ExternalResource = {
    resourceId,
    resourceType: type,
    sourceVersion: input.file.updatedAt,
    title: input.file.name,
    ownerRef: `feishu:union_id:${input.unionId}`,
    ...(input.file.parentId ? { containerRef: input.file.parentId } : {}),
    ...(input.file.sourceUrl ? { sourceUrl: input.file.sourceUrl } : {}),
    observedAt: nowIso(),
    ...(body ? { contentHash: createHash('sha256').update(body).digest('hex') } : {}),
    accessLabel: 'shared',
    retentionPolicy: 'source-linked',
    bodyLoaded: body.length > 0,
    capability: capability(input, readable),
    contentStatus: readable ? (body ? 'loaded' : 'not_loaded') : 'unsupported',
    sourceValidity: 'active',
  };
  return {
    resource,
    version: input.file.updatedAt,
    title: input.file.name,
    ...(body ? { text: body } : {}),
    evidence: body ? [{ sourceResourceId: resourceId, excerpt: boundedEvidence(body), ...(input.file.sourceUrl ? { sourceUrl: input.file.sourceUrl } : {}) }] : [],
    warnings: readable
      ? (body ? [] : [{ code: 'empty_content', message: 'content has not been loaded' }])
      : [{ code: 'unsupported_content_type', message: resource.capability?.unsupportedReason || 'unsupported content type' }],
  };
}
