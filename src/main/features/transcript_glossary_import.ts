/**
 * transcript_glossary_import — 词表导入的文本解析（CSV / JSON）
 *
 * 词表面板支持两种粘贴/文件格式：
 *   - CSV：`wrong,correct[,kind[,riskLevel]]`，首行表头可选（wrong/错形/错词）；
 *   - JSON：`{ "entries": [...] }`（也接受裸数组，以及旧版 `{ payload: { entries } }`）。
 *
 * 解析只做**形状与边界**校验；风险等级、作用域、去重等仍由
 * `transcript_glossary.upsertEntry` 决定——导入不能绕过引擎护栏。
 * 单行不合法只计入 `skipped`，不影响其余条目。
 */

import type { GlossaryKind, RiskLevel } from './transcript_glossary';

export interface ParsedImportEntry {
  wrong: string;
  correct: string;
  kind?: GlossaryKind;
  riskLevel?: RiskLevel;
}

export interface ParsedGlossaryImport {
  format: 'json' | 'csv';
  entries: ParsedImportEntry[];
  skipped: number;
}

const KINDS: ReadonlySet<string> = new Set([
  'product', 'people', 'org', 'term', 'venue', 'course', 'filler',
]);
const RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const MAX_WRONG = 80;
const MAX_CORRECT = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeEntry(raw: unknown): ParsedImportEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const wrong = typeof rec.wrong === 'string' ? rec.wrong.trim() : '';
  const correct = typeof rec.correct === 'string' ? rec.correct.trim() : '';
  if (!wrong || !correct) return null;
  if (wrong.length > MAX_WRONG || correct.length > MAX_CORRECT) return null;
  const kind = typeof rec.kind === 'string' && KINDS.has(rec.kind)
    ? rec.kind as GlossaryKind
    : undefined;
  const riskLevel = typeof rec.riskLevel === 'string' && RISKS.has(rec.riskLevel)
    ? rec.riskLevel as RiskLevel
    : undefined;
  return { wrong, correct, ...(kind ? { kind } : {}), ...(riskLevel ? { riskLevel } : {}) };
}

/** RFC 4180 风格的最小 CSV 切分：引号、转义引号、CRLF、BOM。 */
export function splitCsvRows(text: string): string[][] {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  // 末尾空行不算数据。
  while (rows.length && rows[rows.length - 1]!.every((cell) => cell.trim() === '')) rows.pop();
  return rows;
}

function headerIndex(header: string[], aliases: string[], fallback: number): number {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  for (const alias of aliases) {
    const index = normalized.indexOf(alias);
    if (index >= 0) return index;
  }
  return fallback;
}

function parseCsv(text: string): ParsedGlossaryImport {
  const rows = splitCsvRows(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  if (!rows.length) return { format: 'csv', entries: [], skipped: 0 };

  const first = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const hasHeader = first.some((cell) => ['wrong', '错形', '错词', 'correct', '正形', '正确'].includes(cell));
  const body = hasHeader ? rows.slice(1) : rows;
  const header = hasHeader ? rows[0]! : ['wrong', 'correct', 'kind', 'riskLevel'];
  const wrongIndex = headerIndex(header, ['wrong', '错形', '错词'], 0);
  const correctIndex = headerIndex(header, ['correct', '正形', '正确'], 1);
  const kindIndex = headerIndex(header, ['kind', '类型'], 2);
  const riskIndex = headerIndex(header, ['risklevel', 'risk', '风险', '风险等级'], 3);
  if (wrongIndex === correctIndex) return { format: 'csv', entries: [], skipped: body.length };

  let skipped = 0;
  const entries: ParsedImportEntry[] = [];
  for (const row of body) {
    const parsed = normalizeEntry({
      wrong: row[wrongIndex],
      correct: row[correctIndex],
      kind: row[kindIndex],
      riskLevel: row[riskIndex],
    });
    if (parsed) entries.push(parsed);
    else skipped += 1;
  }
  return { format: 'csv', entries, skipped };
}

function parseJson(text: string): ParsedGlossaryImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('import text is neither CSV nor valid JSON');
  }
  const record = asRecord(parsed);
  const nested = record ? asRecord(record.payload) : null;
  const list = Array.isArray(parsed)
    ? parsed
    : (record && Array.isArray(record.entries)
      ? record.entries
      : (nested && Array.isArray(nested.entries) ? nested.entries : null));
  if (!list) throw new Error('JSON import must contain an entries array');
  let skipped = 0;
  const entries: ParsedImportEntry[] = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { format: 'json', entries, skipped };
}

/**
 * 解析一段导入文本。以 `{` / `[` 开头按 JSON，其余按 CSV。
 * 空文本返回空结果；JSON 形状不对会抛错（由调用方转成用户可读提示）。
 */
export function parseGlossaryImportText(raw: unknown): ParsedGlossaryImport {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { format: 'csv', entries: [], skipped: 0 };
  if (text.startsWith('{') || text.startsWith('[')) return parseJson(text);
  return parseCsv(text);
}
