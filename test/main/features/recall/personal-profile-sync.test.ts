import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'test-profile-sync';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-profile-sync-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSync() {
  return import('../../../../src/main/features/recall/personal-profile-sync');
}

async function loadTemplates() {
  return import('../../../../src/main/features/personal_ontology_template_files');
}

function asset(
  id: string,
  type: 'personal' | 'rule' | 'template' | 'skill_method',
  statement: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    ownerId: UID,
    id,
    candidateId: `cand-${id}`,
    reviewDecisionId: `rd_${id}abcdefgh`,
    type,
    title: statement,
    statement,
    evidenceRefs: [{ kind: 'message', id: `msg-${id}` }],
    scope: 'global',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'seed',
    version: '1',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  } as any;
}

async function installStudentTemplate() {
  const templates = await loadTemplates();
  const result = await templates.installTemplateFile(UID, 'student');
  expect(result.ok).toBe(true);
  const row = templates.readGroups(UID).find((group) => group.template_id === 'student');
  expect(row).toBeDefined();
  return { templates, row: row! };
}

describe('Recall personal profile projection', () => {
  it('projects only active PersonalOntology assets, keeps other asset types untouched, and is idempotent', async () => {
    const { templates, row } = await installStudentTemplate();
    const sync = await loadSync();
    const routeAsset = vi.fn(async () => ({
      action: 'field' as const,
      group_title: '学习背景',
      field_name: '教育阶段',
      confidence: 'high' as const,
    }));
    const assets = [
      asset('aa-personal-a', 'personal', '硕士阶段，专注机器学习方向。'),
      asset('aa-rule-a', 'rule', '项目决策必须保留证据。'),
      asset('aa-template-a', 'template', '评审模板应包含风险项。'),
      asset('aa-skill-a', 'skill_method', '用检查清单完成发布。'),
    ];
    const originalAssets = JSON.parse(JSON.stringify(assets));

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => assets,
      routeAsset,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => assets,
      routeAsset,
    });

    expect(first).toMatchObject({
      eligible: 1,
      written: 1,
      unmatched: 0,
      failed: [],
      profileWritten: 1,
      profileSkipped: 0,
      profileFailed: [],
    });
    expect(second).toMatchObject({
      eligible: 1,
      written: 0,
      skipped: 1,
      failed: [],
      profileWritten: 0,
      profileSkipped: 1,
      profileFailed: [],
    });
    expect(routeAsset).toHaveBeenCalledTimes(1);
    expect(routeAsset).toHaveBeenCalledWith(UID, assets[0].statement, expect.any(Array));

    const fields = await templates.listFieldsByRef(UID, templates.buildContentRef(row.group_id, '学习背景'));
    const education = fields.fields?.find((field) => field.name === '教育阶段');
    expect(education?.values).toEqual([{ value: assets[0].statement, source: '智能' }]);
    const file = templates.readTemplateFileText(UID, 'student');
    expect(file).not.toContain(assets[1].statement);
    expect(file).not.toContain(assets[2].statement);
    expect(file).not.toContain(assets[3].statement);
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([assets[0].statement]);
    expect(assets).toEqual(originalAssets);
  });

  it('writes USER.md even when no role template is installed', async () => {
    const sync = await loadSync();
    const personal = asset('aa-personal-no-template', 'personal', '我偏好先看结论，再看实现细节。');
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      listCatalog: async () => [],
      routeAsset,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      listCatalog: async () => [],
      routeAsset,
    });

    expect(first).toMatchObject({
      eligible: 1,
      written: 0,
      skipped: 1,
      failed: [],
      profileWritten: 1,
      profileSkipped: 0,
    });
    expect(second).toMatchObject({
      profileWritten: 0,
      profileSkipped: 1,
      failed: [],
    });
    expect(routeAsset).not.toHaveBeenCalled();
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([personal.statement]);
  });

  it('keeps a failed USER.md projection retryable', async () => {
    const sync = await loadSync();
    const personal = asset('aa-personal-profile-retry', 'personal', '我的沟通偏好是直接、简洁。');
    const writeProfileEntry = vi.fn()
      .mockReturnValueOnce({ ok: false, error: 'profile store unavailable' })
      .mockReturnValueOnce({
        ok: true,
        record: { recordId: 'mem_1234567890abcdef', text: personal.statement, contentSha256: 'a'.repeat(64) },
      });

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      listCatalog: async () => [],
      writeProfileEntry,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      listCatalog: async () => [],
      writeProfileEntry,
    });

    expect(first.profileFailed).toEqual([{ assetId: personal.id, error: 'profile store unavailable' }]);
    expect(first.failed).toContainEqual({ assetId: personal.id, error: 'profile store unavailable' });
    expect(second).toMatchObject({ profileWritten: 1, profileFailed: [], failed: [] });
    expect(writeProfileEntry).toHaveBeenCalledTimes(2);
  });

  it('keeps USER.md projection independent when the role-template catalog is unavailable', async () => {
    const sync = await loadSync();
    const personal = asset('aa-personal-catalog-retry', 'personal', '我偏好先看结论。');

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      listCatalog: async () => { throw new Error('template catalog offline'); },
    });

    expect(result).toMatchObject({
      eligible: 1,
      profileWritten: 1,
      profileFailed: [],
      failed: [],
    });
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([personal.statement]);
  });

  it('does not route PersonalOntology assets that are paused or unreviewed', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));
    const assets = [
      asset('aa-personal-unreviewed', 'personal', '这条没有合法的审核决策。', {
        reviewDecisionId: 'legacy-untracked',
      }),
      asset('aa-personal-paused', 'personal', '这条资产已暂停。', {
        status: 'paused',
      }),
    ];

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => assets,
      routeAsset,
    });

    expect(result).toEqual({
      eligible: 0,
      written: 0,
      skipped: 0,
      unmatched: 0,
      failed: [],
      profileWritten: 0,
      profileSkipped: 0,
      profileFailed: [],
    });
    expect(routeAsset).not.toHaveBeenCalled();
  });

  it('shows an ontology-linked Personal asset in USER.md without re-routing it to a role template', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const linked = asset('aa-personal-linked', 'personal', '我在软件研发领域工作。', {
      ontologyRefs: [{ ontologyId: 'existing-ontology-node' }],
    });
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [linked],
      routeAsset,
    });

    expect(result).toMatchObject({
      eligible: 1,
      written: 0,
      skipped: 1,
      profileWritten: 1,
      failed: [],
    });
    expect(routeAsset).not.toHaveBeenCalled();
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([linked.statement]);
  });

  it('projects automatic conversation Personal assets but excludes system-precipitated identity claims', async () => {
    const sync = await loadSync();
    const automatic = asset('aa-personal-automatic', 'personal', '我习惯使用 TypeScript。', {
      lifecycleStatus: 'automatically_extracted_unverified',
      maturity: 'seed',
    });
    const system = asset('aa-personal-system', 'personal', '系统推断出的身份不应自动进入画像。', {
      lifecycleStatus: 'system_precipitated_unverified',
      maturity: 'seed',
    });

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [automatic, system],
      listCatalog: async () => [],
    });

    expect(result).toMatchObject({ eligible: 1, profileWritten: 1, failed: [] });
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([automatic.statement]);
  });

  it('writes a user-selected template field during the same projection pass', async () => {
    const { templates, row } = await installStudentTemplate();
    const sync = await loadSync();
    const contract = await import('../../../../src/main/features/personal_ontology_contract');
    const personal = asset('aa-personal-explicit-target', 'personal', '我是一名程序员，有十年经验。');
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));

    // 落点只传一个 opaque fieldRef——不再带 groupId/section/fieldName/templateId
    const fieldRef = contract.buildRoleTemplateFieldRef('student', '学习背景', '专业与学习方向')!;
    expect(fieldRef).toBeTruthy();

    const result = await sync.syncPersonalProfileFromRecallAssets(
      UID,
      { listAssets: async () => [personal], routeAsset },
      { assetId: personal.id, target: { fieldRef } },
    );

    expect(result).toMatchObject({ eligible: 1, written: 1, failed: [] });
    expect(routeAsset).not.toHaveBeenCalled();
    const fields = await templates.listFieldsByRef(UID, templates.buildContentRef(row.group_id, '学习背景'));
    expect(fields.fields?.find((field) => field.name === '专业与学习方向')?.values).toEqual([
      { value: personal.statement, source: '智能' },
    ]);
  });

  it('rejects an explicit target that is not a valid PO field ref', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const personal = asset('aa-personal-invalid-target', 'personal', '不应写入不存在的字段。');

    // 伪造/损坏的句柄解不出落点 → 该资产失败，其余资产不受影响
    const result = await sync.syncPersonalProfileFromRecallAssets(
      UID,
      { listAssets: async () => [personal] },
      { assetId: personal.id, target: { fieldRef: 'po1bogus' } },
    );

    expect(result).toMatchObject({ eligible: 1, written: 0, unmatched: 0 });
    expect(result.failed).toEqual([{ assetId: personal.id, error: 'profile target field not found' }]);
  });

  it('rejects a well-formed ref whose field is outside the template T-box', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const contract = await import('../../../../src/main/features/personal_ontology_contract');
    const personal = asset('aa-personal-non-tbox', 'personal', '自定义字段不许自动写。');

    // T-box 外的字段拿不到句柄——白名单在发句柄那一刻就生效了
    expect(contract.buildRoleTemplateFieldRef('student', '学习背景', '自定义备注')).toBeNull();

    const result = await sync.syncPersonalProfileFromRecallAssets(
      UID,
      { listAssets: async () => [personal] },
      { assetId: personal.id, target: { fieldRef: 'po1' + Buffer.from(JSON.stringify({ k: 'tf', t: 'student', s: '学习背景', f: '自定义备注' })).toString('base64url') } },
    );
    expect(result.failed).toEqual([
      { assetId: personal.id, error: 'field is not declared by the role template' },
    ]);
  });

  it('does not overwrite a manually maintained profile value', async () => {
    const { templates, row } = await installStudentTemplate();
    const ref = templates.buildContentRef(row.group_id, '学习背景');
    await templates.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    const sync = await loadSync();
    const personal = asset('aa-personal-b', 'personal', '硕士');

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset: async () => ({ action: 'field', group_title: '学习背景', field_name: '教育阶段', confidence: 'high' }),
    });

    expect(result.written).toBe(1);
    const fields = await templates.listFieldsByRef(UID, ref);
    expect(fields.fields?.find((field) => field.name === '教育阶段')?.values).toEqual([
      { value: '本科', source: '手动' },
      { value: '硕士', source: '智能' },
    ]);
  });

  it('leaves unmatched personal assets in Recall instead of forcing them into a role field', async () => {
    const { templates } = await installStudentTemplate();
    const sync = await loadSync();
    const personal = asset('aa-personal-c', 'personal', '我今天状态不错。');

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset: async () => ({ action: 'flow' }),
    });

    expect(result).toMatchObject({ eligible: 1, written: 0, unmatched: 1, failed: [] });
    expect(templates.readTemplateFileText(UID, 'student')).not.toContain(personal.statement);
  });

  it('excludes custom fields from automatic routing and never writes into them', async () => {
    const { templates, row } = await installStudentTemplate();
    const ref = templates.buildContentRef(row.group_id, '学习背景');
    expect((await templates.appendFieldValueToRef(UID, ref, '自定义备注', '用户手工内容', '手动')).ok).toBe(true);
    const sync = await loadSync();
    const personal = asset('aa-personal-custom', 'personal', '不应自动写入自定义字段。');
    const routeAsset = vi.fn(async (_uid: string, _statement: string, catalog: any[]) => {
      expect(catalog.flatMap((entry) => entry.sections)
        .flatMap((section) => section.fields)).not.toContain('自定义备注');
      return {
        action: 'field' as const,
        group_title: '学习背景',
        field_name: '自定义备注',
        confidence: 'high' as const,
      };
    });

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset,
    });

    expect(result).toMatchObject({ eligible: 1, written: 0, unmatched: 1, failed: [] });
    expect(routeAsset).toHaveBeenCalledTimes(1);
    const fields = await templates.listFieldsByRef(UID, ref);
    expect(fields.fields?.find((field) => field.name === '自定义备注')).toMatchObject({
      isCustom: true,
      values: [{ value: '用户手工内容', source: '手动' }],
    });
    expect(templates.readTemplateFileText(UID, 'student')).not.toContain(personal.statement);
  });

  it('does not recreate a built-in field deleted after routing started', async () => {
    const { templates, row } = await installStudentTemplate();
    const ref = templates.buildContentRef(row.group_id, '学习背景');
    const sync = await loadSync();
    const personal = asset('aa-personal-deleted-field', 'personal', '硕士阶段。');

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset: async () => {
        expect((await templates.removeFieldToRef(UID, ref, '教育阶段')).ok).toBe(true);
        return {
          action: 'field',
          group_title: '学习背景',
          field_name: '教育阶段',
          confidence: 'high',
        } as const;
      },
    });

    expect(result).toMatchObject({ eligible: 1, written: 0, unmatched: 0 });
    expect(result.failed).toEqual([{ assetId: personal.id, error: 'field not found' }]);
    const fields = await templates.listFieldsByRef(UID, ref);
    expect(fields.fields?.some((field) => field.name === '教育阶段')).toBe(false);
    expect(templates.readTemplateFileText(UID, 'student')).not.toContain(personal.statement);
  });

  it('does not append a second profile value when an applied asset changes version or statement', async () => {
    const { templates, row } = await installStudentTemplate();
    const sync = await loadSync();
    const initial = asset('aa-personal-versioned', 'personal', '本科阶段。');
    const changed = {
      ...initial,
      version: '2',
      statement: '硕士阶段。',
      title: '硕士阶段。',
      updatedAt: '2026-08-14T01:00:00.000Z',
    };
    const routeAsset = vi.fn(async () => ({
      action: 'field' as const,
      group_title: '学习背景',
      field_name: '教育阶段',
      confidence: 'high' as const,
    }));

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [initial],
      routeAsset,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [changed],
      routeAsset,
    });

    expect(first).toMatchObject({ written: 1, failed: [] });
    expect(second).toMatchObject({ eligible: 1, written: 0, skipped: 1, failed: [] });
    expect(routeAsset).toHaveBeenCalledTimes(1);
    const fields = await templates.listFieldsByRef(
      UID,
      templates.buildContentRef(row.group_id, '学习背景'),
    );
    expect(fields.fields?.find((field) => field.name === '教育阶段')?.values).toEqual([
      { value: initial.statement, source: '智能' },
    ]);
    expect(templates.readTemplateFileText(UID, 'student')).not.toContain(changed.statement);
  });

  it('caches a stable no-match decision for the same asset and template catalog', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const personal = asset('aa-personal-no-match', 'personal', '今天天气不错。');
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset,
    });

    expect(first).toMatchObject({ unmatched: 1, failed: [] });
    expect(second).toMatchObject({ eligible: 1, unmatched: 0, skipped: 1, failed: [] });
    expect(routeAsset).toHaveBeenCalledTimes(1);
  });

  it('retries a routing failure and can apply the asset on the next sync', async () => {
    const { templates, row } = await installStudentTemplate();
    const sync = await loadSync();
    const personal = asset('aa-personal-retry', 'personal', '专注机器学习方向。');
    const routeAsset = vi.fn()
      .mockResolvedValueOnce({ action: 'flow', failure: 'model_unavailable' })
      .mockResolvedValueOnce({
        action: 'field',
        group_title: '学习背景',
        field_name: '专业与学习方向',
        confidence: 'high',
      });

    const first = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset,
    });
    const second = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [personal],
      routeAsset,
    });

    expect(first).toMatchObject({ eligible: 1, written: 0, unmatched: 0 });
    expect(first.failed).toEqual([{
      assetId: personal.id,
      error: 'profile routing model_unavailable',
    }]);
    expect(second).toMatchObject({ eligible: 1, written: 1, failed: [] });
    expect(routeAsset).toHaveBeenCalledTimes(2);
    const fields = await templates.listFieldsByRef(
      UID,
      templates.buildContentRef(row.group_id, '学习背景'),
    );
    expect(fields.fields?.find((field) => field.name === '专业与学习方向')?.values).toEqual([
      { value: personal.statement, source: '智能' },
    ]);
  });

  it('isolates a damaged projection receipt and continues syncing other assets', async () => {
    const { templates, row } = await installStudentTemplate();
    const sync = await loadSync();
    const paths = await import('../../../../src/main/features/recall/paths');
    const damaged = asset('aa-personal-damaged-receipt', 'personal', '这条收据会被损坏。');
    const healthy = asset('aa-personal-healthy', 'personal', '研究方向是机器学习。');

    await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [damaged],
      routeAsset: async () => ({ action: 'flow' }),
    });
    const receiptDir = path.dirname(paths.recallJsonRecordPath(
      UID,
      'personal-profile-projections',
      'placeholder',
    ));
    const [receiptName] = fs.readdirSync(receiptDir);
    expect(receiptName).toBeTruthy();
    fs.writeFileSync(path.join(receiptDir, receiptName), '{not valid json', 'utf8');

    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {
      listAssets: async () => [damaged, healthy],
      routeAsset: async () => ({
        action: 'field',
        group_title: '学习背景',
        field_name: '专业与学习方向',
        confidence: 'high',
      }),
    });

    expect(result).toMatchObject({ eligible: 2, written: 1, unmatched: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ assetId: damaged.id });
    const fields = await templates.listFieldsByRef(
      UID,
      templates.buildContentRef(row.group_id, '学习背景'),
    );
    expect(fields.fields?.find((field) => field.name === '专业与学习方向')?.values).toEqual([
      { value: healthy.statement, source: '智能' },
    ]);
  });
});

// 投影过去只有渲染层在打开「关于我」时触发（personal-ontology.js），用户不进
// 那个页面就永远不同步。主进程在 personal 资产晋升成功后要自己发起一次。
describe('personal profile projection is driven from the main process', () => {
  it('writes a confirmed Personal asset into USER.md during promotion', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '我偏好先看结论，再看实现细节。',
      value: '后续回答应优先给出明确结论。',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-profile-memory' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-profile-memory' }],
    });

    const promoted = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });

    expect(promoted.profileProjection).toMatchObject({
      eligible: 1,
      profileWritten: 1,
      profileFailed: [],
    });
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.listEntries(UID, 'user').entries).toEqual([promoted.asset.statement]);
    expect(memory.findPersonalProfileEntry(UID, promoted.asset.id)?.text).toBe(promoted.asset.statement);
  });

  it('schedules a projection after a personal asset is promoted', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const sync = await import('../../../../src/main/features/recall/personal-profile-sync');
    const scheduled: string[] = [];
    const spy = vi.spyOn(sync, 'schedulePersonalProfileSync').mockImplementation(async (userId: string) => {
      scheduled.push(userId);
      return { eligible: 0, written: 0, skipped: 0, unmatched: 0, failed: [] };
    });

    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '我长期偏好先给整体结构，再补细节。',
      value: '后续任务可以直接按结构优先的方式组织输出。',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-profile' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-profile' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    expect(asset.type).toBe('personal');

    // fire-and-forget：让微任务跑完再断言。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toContain(UID);
    spy.mockRestore();
  });

  it('does not schedule a projection for non-personal assets', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const sync = await import('../../../../src/main/features/recall/personal-profile-sync');
    const scheduled: string[] = [];
    const spy = vi.spyOn(sync, 'schedulePersonalProfileSync').mockImplementation(async (userId: string) => {
      scheduled.push(userId);
      return { eligible: 0, written: 0, skipped: 0, unmatched: 0, failed: [] };
    });

    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '正式评审必须先讲产品模型，再谈实现细节。',
      value: '避免评审跑偏到实现细节上。',
      suggestedType: 'rule',
      suggestedScope: 'review',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-rule' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-rule' }],
    });
    await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toEqual([]);
    spy.mockRestore();
  });

  it('passes an explicit personal-template destination into the projection scheduler', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const sync = await import('../../../../src/main/features/recall/personal-profile-sync');
    const scheduled: Array<{ userId: string; options: unknown }> = [];
    const spy = vi.spyOn(sync, 'schedulePersonalProfileSync').mockImplementation(async (userId: string, options: any) => {
      scheduled.push({ userId, options });
      return { eligible: 1, written: 1, skipped: 0, unmatched: 0, failed: [] };
    });

    const contract = await import('../../../../src/main/features/personal_ontology_contract');
    const PROFILE_FIELD_REF = contract.buildRoleTemplateFieldRef('student', '学习背景', '专业与学习方向')!;
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '我长期从事程序开发。',
      value: '后续可按技术工作者的背景理解我的需求。',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-profile-target' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-profile-target' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, {
      actor: 'user',
      profileTarget: { fieldRef: PROFILE_FIELD_REF },
    });

    expect(asset.type).toBe('personal');
    expect(scheduled).toEqual([{
      userId: UID,
      options: {
        assetId: asset.id,
        target: { fieldRef: PROFILE_FIELD_REF },
      },
    }]);
    spy.mockRestore();
  });
});

describe('personal profile projection › catalog 指纹不含 PO 内部寻址', () => {
  it('no_match 回执在卸载重装（group_id 变化）后仍作数——指纹只看模板与字段清单', async () => {
    const templates = await import('../../../../src/main/features/personal_ontology_template_files');
    const sync = await loadSync();

    const first = await installStudentTemplate();
    const firstGroupId = first.row.group_id;
    const personal = asset('aa-personal-fingerprint', 'personal', '一条路由不到任何字段的通用偏好。');
    // flow → 落 no_match 回执，catalogFingerprint 才会参与 isSettledForInput
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));

    const before = await sync.syncPersonalProfileFromRecallAssets(
      UID, { listAssets: async () => [personal], routeAsset }, { assetId: personal.id },
    );
    expect(before).toMatchObject({ unmatched: 1 });
    expect(routeAsset).toHaveBeenCalledTimes(1);

    // 卸载重装 → group_id 变了，但模板与字段清单一模一样
    await templates.uninstallTemplateFile(UID, 'student');
    await templates.installTemplateFile(UID, 'student');
    const secondGroupId = templates.readGroups(UID).find((g) => g.template_id === 'student')!.group_id;
    expect(secondGroupId).not.toBe(firstGroupId);

    // 指纹未变 → 回执仍结算 → 不再重复调用路由（指纹若含 group_id 这里会重跑）
    routeAsset.mockClear();
    const after = await sync.syncPersonalProfileFromRecallAssets(
      UID, { listAssets: async () => [personal], routeAsset }, { assetId: personal.id },
    );
    expect(after).toMatchObject({ skipped: 1, unmatched: 0 });
    expect(routeAsset).not.toHaveBeenCalled();
  });
});
