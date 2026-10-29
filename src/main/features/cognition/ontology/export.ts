/**
 * 本体导出：同一权威读口的只读时点快照。
 *
 * 纪律：
 *   - 读取只经 readOntologyView（含旧文件只读投影），不另起读口；
 *   - 导出内容离开应用边界 → 最小暴露：仅 owner 本人可见（owner_only）记录
 *     一律不进导出，被省略的数量如实计数（omittedOwnerOnlyCount），不静默；
 *   - 不携带 ownerId／用户路径；记录按拥有模块分组，id／版本／状态／来源／
 *     有效期原样保留——「历史、来源和导出语义一致」；
 *   - 纯投影零写入：导出不是迁移，也不承诺可直接回导。
 */
import { OntologyError, type OntologyDocument, type OntologyRecord } from './model';
import { readOntologyView } from './service';

export interface OntologyExportResult {
  json: string;
  bytes: number;
}

function exportable(record: OntologyRecord): boolean {
  return record.access !== 'owner_only';
}

export async function buildOntologyExport(userId: string, moduleId?: string): Promise<OntologyExportResult> {
  const doc: OntologyDocument = await readOntologyView(userId);
  const modules = Object.values(doc.records).filter((r): r is Extract<OntologyRecord, { kind: 'module' }> =>
    r.kind === 'module' && r.status === 'active' && r.access === 'task');
  let scoped = modules;
  if (moduleId !== undefined) {
    scoped = modules.filter(m => m.id === moduleId);
    if (!scoped.length) throw new OntologyError('not_found', 'ontology module unavailable');
  }
  const moduleIds = new Set(scoped.map(m => m.id));
  let omittedOwnerOnly = 0;
  const payload: Record<string, unknown> = {
    schema: 'cogseed-ontology-export/1',
    exportedAt: new Date().toISOString(),
    scope: moduleId === undefined ? 'all' : moduleId,
    snapshotNotice: 'Read-only snapshot taken at exportedAt; records carry their own id/version/status/source. Not an import format.',
    revision: doc.revision,
    modules: scoped.map(module => {
      const records = Object.values(doc.records).filter(r => r.kind !== 'module' && r.moduleId === module.id);
      const visible = records.filter(exportable);
      omittedOwnerOnly += records.length - visible.length;
      return { ...module, records: visible };
    }),
  };
  Object.assign(payload, { omittedOwnerOnlyCount: omittedOwnerOnly });
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf8') > 32 * 1024 * 1024) throw new OntologyError('capacity_exceeded', 'ontology export exceeds size limit');
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}
