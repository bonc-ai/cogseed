import { safeId } from '../../storage';

export const COGNITION_SOURCE_TYPES = [
  'conversation',
  'artifact_file',
  'execution_evaluation',
  'user_teaching_signal',
  'authorized_external_system',
] as const;

// Kept as an export alias for existing imports. The catalog and all new writes
// now use only the PRD v2 taxonomy above.
export const COGNITION_SOURCE_KINDS = COGNITION_SOURCE_TYPES;

export const COGNITION_SOURCE_SUBTYPES = [
  'session',
  'message',
  'artifact',
  'context_file',
  'execution',
  'evaluation',
  'teaching',
  'connector_record',
] as const;

export type CognitionSourceType = typeof COGNITION_SOURCE_TYPES[number];
export type CognitionSourceKind = CognitionSourceType;
export type CognitionSourceSubtype = typeof COGNITION_SOURCE_SUBTYPES[number];
export type CognitionSourceScope = 'personal' | 'project' | 'agent' | 'workspace' | 'conversation' | 'external';

export const LEGACY_COGNITION_SOURCE_KINDS = [
  'memory',
  'context',
  'ontology',
  'execution',
  'message',
  'artifact',
] as const;

export type LegacyCognitionSourceKind = typeof LEGACY_COGNITION_SOURCE_KINDS[number];

export interface CognitionSourceRef {
  /** New writers use v2 discriminants. Explicit legacy inputs remain legacy so
   * existing consumers can complete their own migration without losing stable
   * evidence keys in this release. */
  kind: CognitionSourceType | LegacyCognitionSourceKind;
  id: string;
  taxonomyVersion: 1 | 2;
  subtype: CognitionSourceSubtype;
  scope?: CognitionSourceScope;
  sourceVersion?: string;
  authorizationRef?: string;
  title?: string;
  excerpt?: string;
  degraded?: boolean;
  reason?: string;
}

export interface CognitionSourceInput {
  kind: CognitionSourceType | LegacyCognitionSourceKind;
  id: string;
  taxonomyVersion?: number;
  subtype?: CognitionSourceSubtype;
  scope?: CognitionSourceScope;
  sourceVersion?: string;
  authorizationRef?: string;
  title?: string;
  excerpt?: string;
  degraded?: boolean;
  reason?: string;
}

const SOURCE_TYPES = new Set<string>(COGNITION_SOURCE_TYPES);
const LEGACY_SOURCE_TYPES = new Set<string>(LEGACY_COGNITION_SOURCE_KINDS);
const SOURCE_SUBTYPES = new Set<string>(COGNITION_SOURCE_SUBTYPES);
const SOURCE_SCOPES = new Set<string>(['personal', 'project', 'agent', 'workspace', 'conversation', 'external']);
const MAX_TITLE_LENGTH = 120;
const MAX_EXCERPT_LENGTH = 240;
const SECRET_VALUE_RE = /(\b(?:authorization\s*:\s*bearer\s+|bearer\s+|token\s*[=:]\s*|api[_-]?key\s*[=:]\s*))([^\s,;]+)/gi;
const SENSITIVE_KEY_VALUE_RE = /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|cookie)\s*[=:]\s*)([^\s,;]+)/gi;
const JSON_SECRET_VALUE_RE = /((?:[\"'])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|token|password|secret|cookie)(?:[\"'])\s*:\s*[\"'])(?:\\.|[^\"'])*(?=[\"'])/gi;

const DEFAULT_SUBTYPE: Record<CognitionSourceType, CognitionSourceSubtype> = {
  conversation: 'session',
  artifact_file: 'artifact',
  execution_evaluation: 'execution',
  user_teaching_signal: 'teaching',
  authorized_external_system: 'connector_record',
};

const ALLOWED_SUBTYPES: Record<CognitionSourceType, ReadonlySet<CognitionSourceSubtype>> = {
  conversation: new Set(['session', 'message']),
  artifact_file: new Set(['artifact', 'context_file']),
  execution_evaluation: new Set(['execution', 'evaluation']),
  user_teaching_signal: new Set(['teaching']),
  authorized_external_system: new Set(['connector_record']),
};

function compactText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  return compacted.length <= max ? compacted : `${compacted.slice(0, Math.max(1, max - 1))}…`;
}

function isSourceType(value: unknown): value is CognitionSourceType {
  return typeof value === 'string' && SOURCE_TYPES.has(value);
}

function isLegacySourceType(value: unknown): value is LegacyCognitionSourceKind {
  return typeof value === 'string' && LEGACY_SOURCE_TYPES.has(value);
}

function isSourceSubtype(value: unknown): value is CognitionSourceSubtype {
  return typeof value === 'string' && SOURCE_SUBTYPES.has(value);
}

function isSourceScope(value: unknown): value is CognitionSourceScope {
  return typeof value === 'string' && SOURCE_SCOPES.has(value);
}

export function redactSourceExcerpt(value: unknown): string | undefined {
  const compacted = compactText(value, MAX_EXCERPT_LENGTH * 3);
  if (!compacted) return undefined;
  const redacted = compacted
    .replace(SECRET_VALUE_RE, '$1[REDACTED]')
    .replace(SENSITIVE_KEY_VALUE_RE, '$1[REDACTED]')
    .replace(JSON_SECRET_VALUE_RE, '$1[REDACTED]');
  return compactText(redacted, MAX_EXCERPT_LENGTH);
}

function parseStringRef(value: string): CognitionSourceInput | undefined {
  const trimmed = value.trim();
  const match = /^([a-z0-9_]+):\/\/(.+)$/i.exec(trimmed) || /^([a-z0-9_]+):(.+)$/i.exec(trimmed);
  if (match && (isSourceType(match[1]) || isLegacySourceType(match[1])) && safeId(match[2])) {
    return { kind: match[1], id: match[2] };
  }
  // The v1 store used bare ids for memory references. They remain readable as
  // degraded teaching inputs, but no v2 writer emits this form.
  if (safeId(trimmed)) return { kind: 'memory', id: trimmed };
  return undefined;
}

function canonicalizeSource(source: CognitionSourceInput): {
  kind: CognitionSourceType | LegacyCognitionSourceKind;
  taxonomyVersion: 1 | 2;
  subtype: CognitionSourceSubtype;
  degraded?: boolean;
  reason?: string;
} | undefined {
  if (isSourceType(source.kind)) {
    const subtype = source.subtype || DEFAULT_SUBTYPE[source.kind];
    if (!isSourceSubtype(subtype) || !ALLOWED_SUBTYPES[source.kind].has(subtype)) return undefined;
    return {
      kind: source.kind,
      taxonomyVersion: 2,
      subtype,
      ...(source.degraded === true ? { degraded: true } : {}),
      ...(source.reason ? { reason: source.reason } : {}),
    };
  }

  switch (source.kind) {
    case 'message':
      return { kind: 'message', taxonomyVersion: 1, subtype: 'message' };
    case 'artifact':
      return { kind: 'artifact', taxonomyVersion: 1, subtype: 'artifact' };
    case 'context':
      return { kind: 'context', taxonomyVersion: 1, subtype: 'context_file' };
    case 'execution':
      return { kind: 'execution', taxonomyVersion: 1, subtype: 'execution' };
    case 'memory':
      return { kind: 'memory', taxonomyVersion: 1, subtype: 'teaching', degraded: true, reason: 'legacy_memory_untraceable' };
    case 'ontology':
      return { kind: 'ontology', taxonomyVersion: 1, subtype: 'artifact', degraded: true, reason: 'legacy_ontology_asset_ref' };
    default:
      return undefined;
  }
}

export function cognitionSourceRefKey(ref: Pick<CognitionSourceRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`;
}

export function normalizeCognitionSourceRef(input: unknown): CognitionSourceRef | undefined {
  const source = typeof input === 'string'
    ? parseStringRef(input)
    : input && typeof input === 'object' && !Array.isArray(input)
      ? input as Partial<CognitionSourceInput>
      : undefined;
  if (
    !source
    || (!isSourceType(source.kind) && !isLegacySourceType(source.kind))
    || typeof source.id !== 'string'
    || !safeId(source.id)
  ) return undefined;

  const canonical = canonicalizeSource(source as CognitionSourceInput);
  if (!canonical) return undefined;
  const title = compactText(source.title, MAX_TITLE_LENGTH);
  const excerpt = redactSourceExcerpt(source.excerpt);
  const reason = compactText(canonical.reason || source.reason, MAX_TITLE_LENGTH);
  const sourceVersion = compactText(source.sourceVersion, 80);
  const authorizationRef = typeof source.authorizationRef === 'string' && safeId(source.authorizationRef)
    ? source.authorizationRef
    : undefined;
  return {
    kind: canonical.kind,
    id: source.id,
    taxonomyVersion: canonical.taxonomyVersion,
    subtype: canonical.subtype,
    ...(isSourceScope(source.scope) ? { scope: source.scope } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(authorizationRef ? { authorizationRef } : {}),
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(canonical.degraded === true || source.degraded === true ? { degraded: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function normalizeCognitionSourceRefs(inputs: unknown[]): CognitionSourceRef[] {
  const out: CognitionSourceRef[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const ref = normalizeCognitionSourceRef(input);
    if (!ref) continue;
    const key = cognitionSourceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isAbsolutePathLike(value: string): boolean {
  return /^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(value);
}

/** Persist only stable source metadata. Legacy readers may still expose a
 * redacted excerpt, but v2 RecallView/Candidate writers never copy source body
 * text or absolute paths into a reference. */
export function cognitionSourceRefMetadataOnly(ref: CognitionSourceRef): CognitionSourceRef {
  const { excerpt: _excerpt, ...metadata } = ref;
  if (!metadata.title || !isAbsolutePathLike(metadata.title)) return metadata;
  const { title: _title, ...withoutAbsoluteTitle } = metadata;
  return withoutAbsoluteTitle;
}

export function normalizeCognitionSourceRefsForWrite(inputs: unknown[]): CognitionSourceRef[] {
  return normalizeCognitionSourceRefs(inputs).map(cognitionSourceRefMetadataOnly);
}

export function cognitionSourceRefKeys(
  inputs: unknown[],
  fallbackKind: CognitionSourceType | LegacyCognitionSourceKind,
): string[] {
  return normalizeCognitionSourceRefs(inputs.map((input) => {
    if (typeof input !== 'string' || /^[a-z0-9_]+:(?:\/\/)?/i.test(input)) return input;
    return { kind: fallbackKind, id: input };
  })).map(cognitionSourceRefKey);
}
