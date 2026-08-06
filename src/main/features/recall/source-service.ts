import { safeId } from '../../storage';

export const COGNITION_SOURCE_KINDS = [
  'memory',
  'context',
  'ontology',
  'p3394_experience',
  'p3394_patch',
  'execution',
  'conversation',
  'artifact',
] as const;

export type CognitionSourceKind = typeof COGNITION_SOURCE_KINDS[number];

export interface CognitionSourceRef {
  kind: CognitionSourceKind;
  id: string;
  title?: string;
  excerpt?: string;
  degraded?: boolean;
  reason?: string;
}

export type CognitionSourceInput = CognitionSourceRef | {
  kind: CognitionSourceKind;
  id: string;
  title?: string;
  excerpt?: string;
  degraded?: boolean;
  reason?: string;
};

const SOURCE_KINDS = new Set<string>(COGNITION_SOURCE_KINDS);
const MAX_TITLE_LENGTH = 120;
const MAX_EXCERPT_LENGTH = 240;
const SECRET_VALUE_RE = /(\b(?:authorization\s*:\s*bearer\s+|bearer\s+|token\s*[=:]\s*|api[_-]?key\s*[=:]\s*))([^\s,;]+)/gi;
const SENSITIVE_KEY_VALUE_RE = /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|cookie)\s*[=:]\s*)([^\s,;]+)/gi;
const JSON_SECRET_VALUE_RE = /((?:[\"'])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|token|password|secret|cookie)(?:[\"'])\s*:\s*[\"'])(?:\\.|[^\"'])*(?=[\"'])/gi;

function compactText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  return compacted.length <= max ? compacted : `${compacted.slice(0, Math.max(1, max - 1))}…`;
}

function isSourceKind(value: unknown): value is CognitionSourceKind {
  return typeof value === 'string' && SOURCE_KINDS.has(value);
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

function parseLegacyRef(value: string): CognitionSourceInput | undefined {
  const trimmed = value.trim();
  const match = /^([a-z0-9_]+):\/\/(.+)$/i.exec(trimmed) || /^([a-z0-9_]+):(.+)$/i.exec(trimmed);
  if (match && isSourceKind(match[1]) && safeId(match[2])) {
    return { kind: match[1], id: match[2] };
  }
  if (safeId(trimmed)) return { kind: 'memory', id: trimmed };
  return undefined;
}

export function cognitionSourceRefKey(ref: Pick<CognitionSourceRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`;
}

export function normalizeCognitionSourceRef(input: unknown): CognitionSourceRef | undefined {
  const source = typeof input === 'string'
    ? parseLegacyRef(input)
    : input && typeof input === 'object' && !Array.isArray(input)
      ? input as Partial<CognitionSourceInput>
      : undefined;
  if (!source || !isSourceKind(source.kind) || typeof source.id !== 'string' || !safeId(source.id)) return undefined;

  const title = compactText(source.title, MAX_TITLE_LENGTH);
  const excerpt = redactSourceExcerpt(source.excerpt);
  const reason = compactText(source.reason, MAX_TITLE_LENGTH);
  return {
    kind: source.kind,
    id: source.id,
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(source.degraded === true ? { degraded: true } : {}),
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

export function cognitionSourceRefKeys(inputs: unknown[], fallbackKind: CognitionSourceKind): string[] {
  return normalizeCognitionSourceRefs(inputs.map((input) => {
    if (typeof input !== 'string' || /^[a-z0-9_]+:(?:\/\/)?/i.test(input)) return input;
    return { kind: fallbackKind, id: input };
  })).map(cognitionSourceRefKey);
}
