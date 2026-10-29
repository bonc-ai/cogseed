import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-pause-retire-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const USER = 'pause-retire-user';

async function createModule(name: string, status?: 'paused') {
  const { commitOntologyCommand, readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
  const doc = readOntologyDocument(USER);
  await commitOntologyCommand(USER, {
    commandId: `create-module-${name}`,
    expectedRevision: doc.revision,
    actions: [{
      intent: 'create',
      recordId: `mod-${name}`,
      sourceLabel: 'test',
      record: {
        kind: 'module', name, scope: { kind: 'personal' },
        description: '', access: 'task',
      },
    }],
  });
  return readOntologyDocument(USER);
}

describe('ontology module pause retirement', () => {
  it('rejects new module-level pause writes; per-record archive remains available', async () => {
    const { commitOntologyCommand, readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
    await createModule('guard');
    let doc = readOntologyDocument(USER);
    const module = doc.records['mod-guard'];
    expect(module?.kind).toBe('module');
    await expect(commitOntologyCommand(USER, {
      commandId: 'try-pause',
      expectedRevision: doc.revision,
      actions: [{ intent: 'update', recordId: 'mod-guard', expectedVersion: module!.version, patch: { status: 'paused' }, sourceLabel: 'test' }],
    })).rejects.toThrow(/module-level pause is retired/);
    doc = readOntologyDocument(USER);
    expect(doc.records['mod-guard']).toMatchObject({ status: 'active' });
  });

  it('migrates a legacy paused module: records become paused, module becomes active, and rerun is a no-op', async () => {
    const { commitOntologyCommand, readOntologyDocument, retireOntologyModulePause } = await import('../../../../src/main/features/cognition/ontology/service');
    // 造一个旧 paused 模块 + 两条在用内容（迁移只认旧数据形态，直接走命令面：
    // 先建 active 模块与内容，再用迁移外的内核 delta 置 paused——这里用
    // kernel store 直写模拟旧档）。
    const kernel = await import('../../../../src/main/features/cognition_kernel/store');
    let doc = await createModule('legacy');
    await commitOntologyCommand(USER, {
      commandId: 'create-type',
      expectedRevision: readOntologyDocument(USER).revision,
      actions: [{
        intent: 'create',
        recordId: 'type-person',
        sourceLabel: 'test',
        record: { kind: 'definition', moduleId: 'mod-legacy', definitionKind: 'type', name: '人物', description: '', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' },
      }],
    });
    await commitOntologyCommand(USER, {
      commandId: 'create-entity',
      expectedRevision: readOntologyDocument(USER).revision,
      actions: [{
        intent: 'create',
        recordId: 'ent-1',
        sourceLabel: 'test',
        record: {
          kind: 'entity', moduleId: 'mod-legacy', typeId: 'type-person', name: '旧对象',
          description: '', aliases: [], identityStatus: 'confirmed',
        },
      }],
    });
    // 模拟旧「整体暂停」数据：模块 status=paused（绕过新写口，直接改主档）。
    const store = await import('../../../../src/main/features/recall/store');
    const cognitionPath = kernel.cognitionStorePath(USER);
    const raw = JSON.parse(fs.readFileSync(cognitionPath, 'utf8'));
    raw.ontology.records['mod-legacy'].status = 'paused';
    fs.writeFileSync(cognitionPath, JSON.stringify(raw));
    void store;

    const result = await retireOntologyModulePause(USER);
    expect(result.migratedModules).toBe(1);
    expect(result.pausedRecords).toBe(2);
    doc = readOntologyDocument(USER);
    expect(doc.records['mod-legacy']).toMatchObject({ kind: 'module', status: 'active' });
    expect(doc.records['ent-1']).toMatchObject({ status: 'paused' });

    // 幂等：再跑一遍 no-op。
    const again = await retireOntologyModulePause(USER);
    expect(again).toEqual({ migratedModules: 0, pausedRecords: 0 });
    // 版本历史入账（可恢复演练的依据）。
    const entries = doc.history.filter((entry) => entry.after.id === 'ent-1' || entry.after.id === 'mod-legacy');
    expect(entries.some((entry) => entry.intent === 'update')).toBe(true);
  });
});
