import { changeOntologyModuleLifecycle, commitOntologyCommand, previewOntologyCommand, readOntologyView, archiveOntologyHistory } from '../features/cognition/ontology/service';
import { editOntologyDocument } from '../features/cognition/ontology/document-edit';
import { buildOntologyExport } from '../features/cognition/ontology/export';
import { listOntologyUsageReceipts } from '../features/cognition/ontology/usage-receipt';
import { ontologyRecordsKnownAt, searchOntologyRecords } from '../features/cognition/ontology/query';
import { OntologyError } from '../features/cognition/ontology/model';
import { getCurrentUiLang, getRendererTables } from '../i18n';
import { safeId } from '../storage';
import { BrowserWindow, dialog } from 'electron';

interface IpcContext {
  userId: string;
}

type Payload = Record<string, unknown>;

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid cognition ${field}`);
  return parsed;
}

/** Archive bounds allow 0 (trim everything) but never negative or oversized. */
function nonNegativeInteger(value: unknown, field: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new OntologyError('invalid_input', `invalid ${field}`);
  return parsed;
}

const ONTOLOGY_ERROR_DETAIL_NUMBERS = ['limit', 'current', 'receipts', 'history', 'entries', 'submitted'] as const;
const ONTOLOGY_ERROR_REMEDIES = new Set(['archive_history', 'export_and_split']);

/** Only ontology capacity diagnostics may cross the IPC boundary, and only
 * fixed non-negative counts plus a known remedy token. No messages or paths. */
export function ontologyErrorDetails(channel: string, error: unknown): Record<string, unknown> | undefined {
  if (!channel.startsWith('cognition.ontology.')) return undefined;
  const details = (error as { details?: unknown })?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const source = details as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const key of ONTOLOGY_ERROR_DETAIL_NUMBERS) {
    const value = source[key];
    if (Number.isSafeInteger(value) && Number(value) >= 0) bounded[key] = value;
  }
  if (typeof source.remedy === 'string' && ONTOLOGY_ERROR_REMEDIES.has(source.remedy)) bounded.remedy = source.remedy;
  return Object.keys(bounded).length ? bounded : undefined;
}

function ontologyId(value: unknown, field: string): string {
  if (!safeId(value) || typeof value !== 'string' || value.length > 160) throw new OntologyError('invalid_input', `invalid ${field}`);
  return value;
}
function ontologyText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim().length > max) throw new OntologyError('invalid_input', `invalid ${field}`);
  return value.trim();
}

function ontologyRevision(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new OntologyError('invalid_input', 'invalid knowledge revision');
  return parsed;
}

// 旧版 CognitionAsset 的全部自有入口（list/get/create/evidence.add/confirm/
// defer/reuse/capture）已下线：list 由 ipc/index.ts 以能力资产语义注册；
// 正式候选生产者走 recall.candidates.save 主链。
export const invokeHandlers = {
  // 本体页面直接消费统一认知主档；保存和预览共用同一领域命令，不再写旧图谱文件。
  'cognition.ontology.module.lifecycle': async (payload: Payload, ctx: IpcContext) => {
    if (typeof payload.moduleId !== 'string' || !safeId(payload.moduleId) || (payload.intent !== 'archive' && payload.intent !== 'delete' && payload.intent !== 'restore')
      || typeof payload.expectedRevision !== 'number' || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0
      || typeof payload.expectedVersion !== 'number' || !Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1)
      throw new OntologyError('invalid_input', 'invalid module lifecycle request');
    return changeOntologyModuleLifecycle(ctx.userId, { moduleId: payload.moduleId, intent: payload.intent, expectedRevision: payload.expectedRevision, expectedVersion: payload.expectedVersion });
  },
  'cognition.ontology.snapshot': async (_payload: Payload, ctx: IpcContext) => ({ ontology: await readOntologyView(ctx.userId) }),
  'cognition.ontology.document.edit': async (payload: Payload, ctx: IpcContext) => editOntologyDocument(ctx.userId, payload),
  'cognition.ontology.search': async (payload: Payload, ctx: IpcContext) => ({
    results: searchOntologyRecords(await readOntologyView(ctx.userId), ontologyText(payload.query, 'query', 200),
      typeof payload.moduleId === 'string' && payload.moduleId ? ontologyId(payload.moduleId, 'module id') : undefined),
  }),
  'cognition.ontology.history.get': async (payload: Payload, ctx: IpcContext) => {
    const doc = await readOntologyView(ctx.userId), recordId = ontologyId(payload.recordId, 'record id');
    const limit = Math.min(500, positiveInteger(payload.limit, 'history limit', 100));
    const record = doc.records[recordId];
    if (!record) throw new OntologyError('not_found', 'ontology record unavailable');
    const relatedIds = new Set([recordId]);
    if (record?.kind === 'entity') for (const item of Object.values(doc.records)) {
      if (item.kind === 'assertion' && (item.subjectId === recordId || item.object.kind === 'entity' && item.object.id === recordId)) relatedIds.add(item.id);
    }
    const allHistory = doc.history.filter(row => relatedIds.has(row.after.id));
    const history = allHistory.slice(-limit).reverse();
    const usage = (await listOntologyUsageReceipts(ctx.userId)).filter(row => relatedIds.has(row.recordId)).slice(-limit).reverse();
    const version = payload.version === undefined ? undefined : positiveInteger(payload.version, 'record version', 1);
    const snapshot = version === undefined || version === record?.version ? record
      : [...doc.history].reverse().find(row => row.after.id === recordId && row.after.version === version)?.after;
    if (version !== undefined && !snapshot) throw new OntologyError('not_found', 'ontology version unavailable');
    return { history, record: snapshot || null, usage, historyTruncated: allHistory.length > limit };
  },
  'cognition.ontology.history.archive': async (payload: Payload, ctx: IpcContext) => archiveOntologyHistory(
    ctx.userId,
    nonNegativeInteger(payload.keepHistory, 'history keep', 500, 100000),
    nonNegativeInteger(payload.keepReceipts, 'receipt keep', 500, 20000),
  ),
  'cognition.ontology.command.preview': async (payload: Payload, ctx: IpcContext) => {
    const outcome = previewOntologyCommand(ctx.userId, payload.command);
    return { receipt: outcome.receipt, duplicate: outcome.duplicate,
      changes: outcome.receipt.changedIds.map(id => outcome.document.records[id]) };
  },
  'cognition.ontology.command.commit': async (payload: Payload, ctx: IpcContext) => commitOntologyCommand(ctx.userId, payload.command),
  'cognition.ontology.export': async (payload: Payload, ctx: IpcContext) => {
    const moduleId = payload.moduleId !== undefined ? ontologyId(payload.moduleId, 'ontology module id') : undefined;
    const { json, bytes } = await buildOntologyExport(ctx.userId, moduleId);
    const base = (moduleId ? moduleId : 'ontology').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'ontology';
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const labels = getRendererTables()[getCurrentUiLang()];
    const options = { title: labels['ontologyWorkspace.exportDialogTitle'] || 'Export ontology JSON snapshot',
      defaultPath: `cogseed-ontology-${base}-${Date.now()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }] };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    const fs = await import('node:fs');
    fs.writeFileSync(result.filePath, json, 'utf-8');
    return { ok: true, canceled: false, filePath: result.filePath, bytes };
  },
};
