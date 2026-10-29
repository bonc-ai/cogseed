/** Read final text deliverables from the persisted message's trusted produced list. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPathAllowed, canonicalizePath } from '../../util/path-sandbox';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { getConversationWorkspaceReadRoots } from '../group_chat/conv_workspace';
import { MAX_BYTES_PDF, richDocumentMaxBytes } from '../../util/document-size-limits';
import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const formats = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json']);
const MAX_TEXT_CHARS = 96_000;
const EXTRACTION_VERSION = 1;
export interface PersistedResultRef {
  kind: 'message' | 'execution_output' | 'file'; id: string; contentHash?: string;
  /** Integrity of the original bytes, including non-text edits in Office/PDF. */
  sourceHash?: string;
  contentRange?: { start: number; end: number }; status: 'readable' | 'unverified';
  extraction?: { format: 'pdf' | 'docx' | 'pptx' | 'xlsx'; version: number; coverage: 'text_only' };
}
export interface PersistedResultContent {
  text: string;
  refs: PersistedResultRef[];
  coverage: { complete: boolean; totalFiles: number; readableFiles: number };
}
export interface PersistedResultEvidence { refId: string; start: number; end: number }

/** Resolve one literal passage wholly inside a real source, never a wrapper or
 * a concatenation of message/file boundaries. No escaping or quote repair. */
export function locatePersistedResultExcerpt(content: PersistedResultContent, excerpt: string): PersistedResultEvidence | undefined {
  if (!excerpt) return undefined;
  for (const ref of content.refs) {
    const range = ref.contentRange;
    if (ref.status !== 'readable' || !range) continue;
    const relative = content.text.slice(range.start, range.end).indexOf(excerpt);
    if (relative >= 0) return { refId: ref.id, start: range.start + relative, end: range.start + relative + excerpt.length };
  }
  return undefined;
}

/** The production adoption and independent-check paths share the same latest
 * persisted result and trusted produced manifest, not caller-provided prose. */
export async function readPersistedConversationResult(userId: string, input: { cid: string; taskRunId: string; messageId: string }) {
  if (![userId, input.cid, input.taskRunId, input.messageId].every(safeId)) throw new Error('invalid persisted result reference');
  const messages = await readJsonl<{ id: string; from: string; text?: string; produced?: unknown[]; turn_id?: string;
    run_id?: string; deleted_at?: string; failure_kind?: string }>(conversationMessageReadFile(userId, input.cid), 100_000);
  const message = [...messages].reverse().find(row => row.id === input.messageId);
  if (!message || message.from === 'user' || message.deleted_at || message.failure_kind || message.turn_id !== input.taskRunId) return undefined;
  const content = await readPersistedResultContent(userId, input.cid, message);
  return { content, fingerprint: JSON.stringify([message.from, message.turn_id, message.run_id, message.text, message.produced, content.refs, content.coverage]) };
}

/** Pure existing extractors; no OCR, model calls, cache side effects or Office
 * recalculation. Unrepresented graphics/empty sections keep coverage unknown. */
async function extractDocument(buf: Buffer, extension: string): Promise<{ text: string; format: NonNullable<PersistedResultRef['extraction']>['format']; complete: boolean }> {
  if (extension === '.pdf') {
    const { pdfBufferToPages } = await import('../../util/extract-pdf');
    const pages = await pdfBufferToPages(buf);
    return { text: pages.map((text, index) => `--- page ${index + 1} ---\n${text}`).join('\n\n'),
      format: 'pdf', complete: pages.length > 0 && pages.every(text => !!text.trim()) };
  }
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(buf);
  const hasNonText = zip.getEntries().some(entry => /^(?:word|ppt|xl)\/(?:media|charts|embeddings)\//.test(entry.entryName));
  if (['.docx', '.docm'].includes(extension)) {
    const { docxBufferToMarkdown } = await import('../../util/extract-docx');
    const text = await docxBufferToMarkdown(buf);
    return { text, format: 'docx', complete: !!text.trim() && !hasNonText };
  }
  const { pptxBufferToMarkdown, xlsxBufferToMarkdown } = await import('../../util/extract-office');
  if (['.pptx', '.pptm'].includes(extension)) {
    const text = pptxBufferToMarkdown(buf);
    return { text, format: 'pptx', complete: !!text.trim() && !text.includes('(no text)') && !hasNonText };
  }
  // The existing spreadsheet extractor reads stored values; an unevaluated
  // formula is not a verified result and must not disappear from coverage.
  const missingFormulaValue = zip.getEntries().filter(entry => /^xl\/worksheets\/.*\.xml$/.test(entry.entryName))
    .some(entry => (entry.getData().toString('utf8').match(/<(?:\w+:)?c\b[^>]*>[\s\S]*?<\/(?:\w+:)?c>/g) || [])
      .some(cell => /<(?:\w+:)?f\b/.test(cell) && !/<(?:\w+:)?v\b[^>]*>[^<]+<\//.test(cell)));
  const text = xlsxBufferToMarkdown(buf);
  return { text, format: 'xlsx', complete: /\nRow \d+:/.test(text) && !hasNonText && !missingFormulaValue };
}

export async function readPersistedResultContent(userId: string, cid: string, message: {
  id: string; text?: string; produced?: unknown[]; sourceKind?: 'execution_output';
}): Promise<PersistedResultContent> {
  const text = String(message.text || '');
  const refs: PersistedResultContent['refs'] = [{ kind: message.sourceKind || 'message', id: message.id, contentHash: hash(text), contentRange: { start: 0, end: text.length }, status: 'readable' }];
  const files = [...new Set((message.produced || []).filter((value): value is string => typeof value === 'string' && !!value.trim()))];
  if (!files.length) return { text, refs, coverage: { complete: true, totalFiles: 0, readableFiles: 0 } };
  let roots: string[] = [];
  try {
    const workspaces = await getConversationWorkspaceReadRoots(userId, cid);
    if (workspaces.length) roots = [...workspaces, chatAttachmentDirForConversation(userId, cid)];
  } catch { /* Missing scope cannot grant filesystem access. */ }
  let combined = text;
  let readableFiles = 0, sourceBytes = 0, textChars = 0, plainBytes = 0;
  let completeCoverage = true;
  for (const [index, file] of files.entries()) {
    const id = 'result-' + hash(JSON.stringify([cid, message.id, path.resolve(file)])).slice(0, 24);
    const row: PersistedResultContent['refs'][number] = { kind: 'file', id, status: 'unverified' };
    refs.push(row);
    const extension = path.extname(file).toLowerCase();
    const richByteLimit = richDocumentMaxBytes(extension);
    if (index >= 12 || (!formats.has(extension) && !richByteLimit) || !isPathAllowed(file, roots)) continue;
    try {
      const actual = canonicalizePath(file), before = await fs.stat(actual);
      if (!before.isFile() || before.size > (richByteLimit || 96_000) || sourceBytes + before.size > MAX_BYTES_PDF
        || !richByteLimit && plainBytes + before.size > 96_000) continue;
      const buf = await fs.readFile(actual);
      sourceBytes += buf.length;
      if (!richByteLimit) plainBytes += buf.length;
      const extracted = richByteLimit ? await extractDocument(buf, extension) : undefined;
      const content = extracted ? extracted.text : new TextDecoder('utf-8', { fatal: true }).decode(buf);
      const after = await fs.stat(actual);
      if (!isPathAllowed(file, roots) || canonicalizePath(file) !== actual || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue;
      if (textChars + content.length > MAX_TEXT_CHARS) continue;
      row.status = 'readable'; row.contentHash = hash(content); row.sourceHash = createHash('sha256').update(buf).digest('hex');
      if (extracted) row.extraction = { format: extracted.format, version: EXTRACTION_VERSION, coverage: 'text_only' };
      completeCoverage &&= extracted?.complete !== false;
      readableFiles++; textChars += content.length;
      const prefix = `\n\n[Persisted file ${id}]\n`;
      row.contentRange = { start: combined.length + prefix.length, end: combined.length + prefix.length + content.length };
      combined += `${prefix}${content}\n[End persisted file ${id}]`;
    } catch { /* Unsupported, removed or changing results stay unverified. */ }
  }
  return { text: combined, refs, coverage: { complete: completeCoverage && readableFiles === files.length, totalFiles: files.length, readableFiles } };
}
