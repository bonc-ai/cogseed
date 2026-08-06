import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeTextAtomicSync } from '../storage';

export const ENTRY_SEPARATOR = '\n§\n';
const RECORD_HEADER_NAMESPACE = '<!-- mate-agent-memory:';
const RECORD_HEADER_PREFIX = '<!-- mate-agent-memory:v1 ';
const RECORD_HEADER_SUFFIX = ' -->';
const SAFE_RECORD_ID = /^mem_[a-f0-9]{16}$/;
const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;

export interface MemorySource {
  kind: 'cognition_asset';
  sourceId: string;
}

export interface MemoryRecord {
  recordId: string;
  text: string;
  contentSha256: string;
  independent: boolean;
  sources: MemorySource[];
}

export interface SourcedMemoryRecord {
  recordId: string;
  text: string;
  contentSha256: string;
}

export interface MemoryRecordMutation {
  ok: boolean;
  error?: string;
  records: MemoryRecord[];
  detachedSourceIds: string[];
  nearLimit?: boolean;
}

export interface MemoryRecordLoadResult {
  records: MemoryRecord[];
  corruptMetadata: boolean;
}

export class CorruptMemoryMetadataError extends Error {
  readonly code = 'MEMORY_METADATA_CORRUPT';

  constructor() {
    super('corrupt memory metadata');
    this.name = 'CorruptMemoryMetadataError';
  }
}

interface RecordHeader {
  recordId: string;
  contentSha256: string;
  independent: boolean;
  sources: MemorySource[];
}

function newRecordId(): string {
  return `mem_${crypto.randomBytes(8).toString('hex')}`;
}

export function memoryContentHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

export function validateMemoryText(content: string): string | null {
  if (content.includes('§')) return 'reserved_separator';
  if (content.includes(RECORD_HEADER_NAMESPACE)) return 'reserved_metadata_marker';
  return null;
}

function validSource(value: unknown): value is MemorySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Partial<MemorySource>;
  return source.kind === 'cognition_asset'
    && typeof source.sourceId === 'string'
    && SAFE_SOURCE_ID.test(source.sourceId);
}

function parseHeader(line: string): RecordHeader | null {
  if (!line.startsWith(RECORD_HEADER_PREFIX) || !line.endsWith(RECORD_HEADER_SUFFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(RECORD_HEADER_PREFIX.length, -RECORD_HEADER_SUFFIX.length)) as Partial<RecordHeader>;
    if (!SAFE_RECORD_ID.test(String(parsed.recordId || ''))
        || !CONTENT_HASH.test(String(parsed.contentSha256 || ''))
        || typeof parsed.independent !== 'boolean'
        || !Array.isArray(parsed.sources)
        || !parsed.sources.every(validSource)) return null;
    const sourceIds = new Set(parsed.sources.map((source) => source.sourceId));
    if (sourceIds.size !== parsed.sources.length) return null;
    return {
      recordId: parsed.recordId as string,
      contentSha256: parsed.contentSha256 as string,
      independent: parsed.independent,
      sources: parsed.sources as MemorySource[],
    };
  } catch {
    return null;
  }
}

function legacyRecord(text: string): MemoryRecord {
  const trimmed = text.trim();
  return {
    recordId: newRecordId(),
    text: trimmed,
    contentSha256: memoryContentHash(trimmed),
    independent: true,
    sources: [],
  };
}

function parseSegment(segment: string): { record: MemoryRecord | null; corruptMetadata: boolean } {
  const trimmed = segment.trim();
  if (!trimmed) return { record: null, corruptMetadata: false };
  const newline = trimmed.indexOf('\n');
  if (newline <= 0) {
    return trimmed.includes(RECORD_HEADER_NAMESPACE)
      ? { record: null, corruptMetadata: true }
      : { record: legacyRecord(trimmed), corruptMetadata: false };
  }
  const headerLine = trimmed.slice(0, newline);
  const body = trimmed.slice(newline + 1).trim();
  if (!headerLine.startsWith(RECORD_HEADER_PREFIX)) {
    if (trimmed.includes(RECORD_HEADER_NAMESPACE)) {
      return { record: null, corruptMetadata: true };
    }
    return { record: legacyRecord(trimmed), corruptMetadata: false };
  }
  const header = parseHeader(headerLine);
  if (!header || !body || validateMemoryText(body) || memoryContentHash(body) !== header.contentSha256) {
    // Never surface a malformed machine header to the model as user-authored
    // memory. The whole segment is quarantined until a caller repairs it.
    return { record: null, corruptMetadata: true };
  }
  return { record: { ...header, text: body }, corruptMetadata: false };
}

export function loadMemoryRecordsWithStatus(filePath: string): MemoryRecordLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corruptMetadata: false };
    }
    throw new Error(`failed to read memory records: ${filePath}`, { cause: error });
  }
  if (!raw.trim()) return { records: [], corruptMetadata: false };
  const parsed = raw.split(/\n?§\n?/).map(parseSegment);
  return {
    records: parsed.map(({ record }) => record).filter((record): record is MemoryRecord => !!record),
    corruptMetadata: parsed.some(({ corruptMetadata }) => corruptMetadata),
  };
}

export function loadMemoryRecords(filePath: string): MemoryRecord[] {
  return loadMemoryRecordsWithStatus(filePath).records;
}

function serializedHeader(record: MemoryRecord): string {
  const header: RecordHeader = {
    recordId: record.recordId,
    contentSha256: memoryContentHash(record.text),
    independent: record.independent,
    sources: record.sources,
  };
  return `${RECORD_HEADER_PREFIX}${JSON.stringify(header)}${RECORD_HEADER_SUFFIX}`;
}

export function serializeMemoryRecords(records: MemoryRecord[]): string {
  return records.map((record) => {
    if (record.independent && record.sources.length === 0) return record.text.trim();
    return `${serializedHeader(record)}\n${record.text.trim()}`;
  }).join(ENTRY_SEPARATOR);
}

export function writeMemoryRecords(filePath: string, records: MemoryRecord[], charLimit: number): MemoryRecordMutation {
  const recordIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const record of records) {
    if (!SAFE_RECORD_ID.test(record.recordId) || recordIds.has(record.recordId)) {
      return { ok: false, error: 'invalid_record_id', records, detachedSourceIds: [] };
    }
    recordIds.add(record.recordId);
    if (!record.text.trim() || validateMemoryText(record.text)) {
      return { ok: false, error: 'invalid_record_text', records, detachedSourceIds: [] };
    }
    if (record.contentSha256 !== memoryContentHash(record.text)) {
      return { ok: false, error: 'record_content_mismatch', records, detachedSourceIds: [] };
    }
    for (const source of record.sources) {
      if (!validSource(source) || sourceIds.has(source.sourceId)) {
        return { ok: false, error: 'duplicate_source', records, detachedSourceIds: [] };
      }
      sourceIds.add(source.sourceId);
    }
  }
  const text = serializeMemoryRecords(records);
  const visibleChars = records.map((record) => record.text).join(ENTRY_SEPARATOR).length;
  if (visibleChars > charLimit) {
    return { ok: false, error: 'char_limit_exceeded', records, detachedSourceIds: [] };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeTextAtomicSync(filePath, text);
  return {
    ok: true,
    records,
    detachedSourceIds: [],
    nearLimit: charLimit > 0 && visibleChars >= charLimit * 0.8,
  };
}

function assertSourceId(sourceId: string): void {
  if (!SAFE_SOURCE_ID.test(sourceId)) throw new Error('invalid memory source id');
}

export function findSourcedMemoryRecord(filePath: string, sourceId: string): SourcedMemoryRecord | null {
  assertSourceId(sourceId);
  const loaded = loadMemoryRecordsWithStatus(filePath);
  if (loaded.corruptMetadata) throw new CorruptMemoryMetadataError();
  const matches = loaded.records.filter((record) =>
    record.sources.some((source) => source.kind === 'cognition_asset' && source.sourceId === sourceId));
  if (matches.length > 1) throw new Error(`duplicate memory source: ${sourceId}`);
  const record = matches[0];
  return record ? { recordId: record.recordId, text: record.text, contentSha256: record.contentSha256 } : null;
}

export function ensureSourcedMemoryRecord(
  filePath: string,
  sourceId: string,
  content: string,
  charLimit: number,
): MemoryRecordMutation & { record?: SourcedMemoryRecord } {
  assertSourceId(sourceId);
  const trimmed = content.trim();
  const invalid = validateMemoryText(trimmed);
  if (invalid) return { ok: false, error: invalid, records: loadMemoryRecords(filePath), detachedSourceIds: [] };
  const hash = memoryContentHash(trimmed);
  const loaded = loadMemoryRecordsWithStatus(filePath);
  const records = loaded.records;
  if (loaded.corruptMetadata) {
    return { ok: false, error: 'corrupt_metadata', records, detachedSourceIds: [] };
  }
  const sourced = records.filter((record) => record.sources.some((source) => source.sourceId === sourceId));
  if (sourced.length > 1) return { ok: false, error: 'duplicate_source', records, detachedSourceIds: [] };
  if (sourced.length === 1) {
    const record = sourced[0];
    if (record.contentSha256 !== hash || record.text !== trimmed) {
      return { ok: false, error: 'source_content_mismatch', records, detachedSourceIds: [] };
    }
    return { ok: true, records, detachedSourceIds: [], record };
  }

  let record = records.find((candidate) => candidate.text === trimmed);
  if (record) {
    record.sources.push({ kind: 'cognition_asset', sourceId });
  } else {
    record = {
      recordId: newRecordId(),
      text: trimmed,
      contentSha256: hash,
      independent: false,
      sources: [{ kind: 'cognition_asset', sourceId }],
    };
    records.push(record);
  }
  const result = writeMemoryRecords(filePath, records, charLimit);
  return result.ok ? { ...result, record } : result;
}

export function detachMemorySource(
  filePath: string,
  sourceId: string,
  charLimit: number,
): MemoryRecordMutation {
  assertSourceId(sourceId);
  const loaded = loadMemoryRecordsWithStatus(filePath);
  const records = loaded.records;
  if (loaded.corruptMetadata) {
    return { ok: false, error: 'corrupt_metadata', records, detachedSourceIds: [] };
  }
  let found = false;
  const next: MemoryRecord[] = [];
  for (const record of records) {
    const sources = record.sources.filter((source) => {
      const match = source.sourceId === sourceId;
      found ||= match;
      return !match;
    });
    if (record.independent || sources.length > 0) next.push({ ...record, sources });
  }
  if (!found) return { ok: true, records, detachedSourceIds: [] };
  const result = writeMemoryRecords(filePath, next, charLimit);
  return result.ok ? { ...result, detachedSourceIds: [sourceId] } : result;
}

export function markMatchingRecordIndependent(
  filePath: string,
  content: string,
  charLimit: number,
): MemoryRecordMutation | null {
  const loaded = loadMemoryRecordsWithStatus(filePath);
  const records = loaded.records;
  if (loaded.corruptMetadata) {
    return { ok: false, error: 'corrupt_metadata', records, detachedSourceIds: [] };
  }
  const record = records.find((candidate) => candidate.text === content.trim());
  if (!record || record.independent) return null;
  record.independent = true;
  return writeMemoryRecords(filePath, records, charLimit);
}

export function newIndependentRecord(text: string): MemoryRecord {
  return legacyRecord(text);
}
