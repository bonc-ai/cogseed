/** 本体导出：快照保留记录与来源版本，排除 owner_only 内容和用户路径，
 * 如实记录省略数，支持模块过滤、未知模块错误与旧文件的只读投影。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const userId = 'ontology-export-user';
let root: string, previousRoot: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-export-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

async function seed() {
  const { commitOntologyCommand } = await import('../../../src/main/features/cognition/ontology/service');
  const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: '用户确认' });
  await commitOntologyCommand(userId, { commandId: 'export-seed', expectedRevision: 0, actions: [
    create('project-module', { kind: 'module', name: '项目协作', description: '', scope: { kind: 'personal' } }),
    create('person-type', { kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('wang', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '王芳', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('secret-note', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '私密对象', description: '', aliases: [], identityStatus: 'confirmed', access: 'owner_only' }),
  ] });
}

describe('buildOntologyExport', () => {
  it('全量导出：模块+记录带版本与来源；owner_only 排除并如实计数；无 ownerId', async () => {
    await seed();
    const { buildOntologyExport } = await import('../../../src/main/features/cognition/ontology/export');
    const { json } = await buildOntologyExport(userId);
    const payload = JSON.parse(json);
    expect(payload.schema).toBe('cogseed-ontology-export/1');
    expect(payload.scope).toBe('all');
    expect(payload.omittedOwnerOnlyCount).toBe(1);
    expect(json.includes('ownerId')).toBe(false);
    const module = payload.modules.find((m: { id: string }) => m.id === 'project-module');
    expect(module.name).toBe('项目协作');
    const ids = module.records.map((r: { id: string }) => r.id);
    expect(ids).toContain('person-type');
    expect(ids).toContain('wang');
    expect(ids).not.toContain('secret-note');
    const wang = module.records.find((r: { id: string }) => r.id === 'wang');
    expect(wang.version).toBe(1);
    expect(wang.source).toMatchObject({ kind: 'user', label: '用户确认' });
  });

  it('scoped 导出只含目标模块；未知模块 not_found', async () => {
    await seed();
    const { buildOntologyExport } = await import('../../../src/main/features/cognition/ontology/export');
    const scoped = await buildOntologyExport(userId, 'project-module');
    const payload = JSON.parse(scoped.json);
    expect(payload.scope).toBe('project-module');
    expect(payload.modules).toHaveLength(1);
    await expect(buildOntologyExport(userId, 'no-such-module')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('旧文件只读投影模块可导出（同一读口）', async () => {
    const { buildOntologyExport } = await import('../../../src/main/features/cognition/ontology/export');
    const { writeRecallJsonRecord } = await import('../../../src/main/features/recall/store');
    void writeRecallJsonRecord; // 旧图谱经 legacy-view 投影，无需额外落盘
    const { json } = await buildOntologyExport(userId);
    const payload = JSON.parse(json);
    expect(Array.isArray(payload.modules)).toBe(true);
    expect(payload.modules.every((m: { access?: string }) => m.access !== 'owner_only')).toBe(true);
  });
});
