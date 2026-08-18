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

    expect(first).toMatchObject({ eligible: 1, written: 1, unmatched: 0, failed: [] });
    expect(second).toMatchObject({ eligible: 1, written: 0, skipped: 1, failed: [] });
    expect(routeAsset).toHaveBeenCalledTimes(1);
    expect(routeAsset).toHaveBeenCalledWith(UID, assets[0].statement, expect.any(Array));

    const fields = await templates.listFieldsByRef(UID, templates.buildContentRef(row.group_id, '学习背景'));
    const education = fields.fields?.find((field) => field.name === '教育阶段');
    expect(education?.values).toEqual([{ value: assets[0].statement, source: '智能' }]);
    const file = templates.readTemplateFileText(UID, 'student');
    expect(file).not.toContain(assets[1].statement);
    expect(file).not.toContain(assets[2].statement);
    expect(file).not.toContain(assets[3].statement);
    expect(assets).toEqual(originalAssets);
  });

  it('does not route PersonalOntology assets that are paused, unreviewed, or already linked to ontology', async () => {
    await installStudentTemplate();
    const sync = await loadSync();
    const routeAsset = vi.fn(async () => ({ action: 'flow' as const }));
    const assets = [
      asset('aa-personal-linked', 'personal', '已经有明确本体落点。', {
        ontologyRefs: [{ ontologyId: 'existing-ontology-node' }],
      }),
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

    expect(result).toEqual({ eligible: 0, written: 0, skipped: 0, unmatched: 0, failed: [] });
    expect(routeAsset).not.toHaveBeenCalled();
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
});
