import type { ExternalResource } from '../../contract';

export type StructuredScalar = string | number | boolean | null;
export type StructuredValue = StructuredScalar | StructuredValue[] | { [key: string]: StructuredValue };

export interface ContentEvidence {
  sourceResourceId: string;
  excerpt: string;
  sourceUrl?: string;
  locator?: string;
}

export interface ContentWarning {
  code: 'unsupported_content_type' | 'truncated' | 'empty_content' | 'partial_content';
  message: string;
}

export interface NormalizedContent {
  resource: ExternalResource;
  version: string;
  title: string;
  text?: string;
  structured?: StructuredValue;
  evidence: ContentEvidence[];
  warnings: ContentWarning[];
}

export function boundedEvidence(value: string, maxChars = 600): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
