import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// specs/016 T004/T006：经验条目的字段校验（正反例）与读写落地；
// 准入适配与资产闸门（formal-assets/runtime）逐条一致（FR-005）。
// specs/016 T028：管理动作（暂停/恢复、类型调整、同类合并、归档）——
// 台账、终态拒绝、合并来源可追、归档零出现、资产库零变化（FR-006）。

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-svc';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-svc-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseExperience() {
  const now = new Date().toISOString();
  return {
    id: 'exp-test-0001',
    source: {
      episodeId: 'kse-ep-0001',
      taskGoal: '修复登录超时缺陷',
      taskType: 'code' as const,
      taskStatus: 'confirmed',
    },
    experienceType: 'lesson' as const,
    title: '数据库迁移前先做全量备份',
    body: '遇到数据库结构变更时，先做全量备份再执行迁移脚本。',
    scope: 'code',
    verification: {
      state: 'confirmed' as const,
      outcome: 'better_than_expected' as const,
      deltaR: 0.3,
      confidence: 0.8,
    },
    evidenceRefs: [{ kind: 'conversation' as const, id: 'conv-exp-1' }],
    learningProvenance: {
      projectionId: 'prj-exp-1',
      episodeId: 'kse-ep-0001',
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function setup() {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  return import('../../../../src/main/features/recall/experience-service');
}

/** T028 夹具：按 id/episode/类型/状态生成一条可落库的经验（episode 与
 *  learningProvenance 保持同源，否则 create 校验先拦）。 */
function variantExperience(spec: {
  id: string;
  episode?: string;
  experienceType?: 'lesson' | 'workflow' | 'gap' | 'uncategorized';
  status?: 'active' | 'paused' | 'archived' | 'merged';
  evidenceRefs?: Array<{ kind: 'conversation' | 'artifact_file'; id: string }>;
  title?: string;
  body?: string;
}) {
  const now = new Date().toISOString();
  const episodeId = spec.episode || `kse-${spec.id}`;
  return {
    ...baseExperience(),
    id: spec.id,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    ...(spec.body !== undefined ? { body: spec.body } : {}),
    source: { ...baseExperience().source, episodeId, taskGoal: `任务-${spec.id}` },
    ...(spec.experienceType !== undefined ? { experienceType: spec.experienceType } : {}),
    ...(spec.status !== undefined ? { status: spec.status } : {}),
    ...(spec.evidenceRefs !== undefined ? { evidenceRefs: spec.evidenceRefs } : {}),
    learningProvenance: { ...baseExperience().learningProvenance, episodeId },
    createdAt: now,
    updatedAt: now,
  };
}

describe('experience record validation (T004)', () => {
  it('persists a fully valid experience and reads it back', async () => {
    const service = await setup();
    const created = await service.createExperience(UID, baseExperience());
    expect(created.id).toBe('exp-test-0001');
    expect(created.ownerId).toBe(UID);
    // evidenceRefs 经 normalize 收拢后仍保留一条。
    expect(created.evidenceRefs).toHaveLength(1);

    const read = await service.readExperience(UID, 'exp-test-0001');
    expect(read?.title).toBe('数据库迁移前先做全量备份');
    const listed = await service.listExperiences(UID);
    expect(listed.map((item) => item.id)).toEqual(['exp-test-0001']);
  });

  it('坏档逐条降级（r3）：一条坏经验 JSON 不炸整页，好条目照常列出（对齐 listRecallCandidates 口径）', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());
    await service.createExperience(UID, variantExperience({ id: 'exp-test-0002', episode: 'kse-ep-0002' }));

    // 直接改盘制造坏档一：语义校验失败（asExperience 抛——枚举外 verification.state）。
    const dir = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'experiences');
    const badPath = path.join(dir, 'exp-test-0001.json');
    const bad = JSON.parse(fs.readFileSync(badPath, 'utf8'));
    bad.verification.state = 'bogus_state';
    fs.writeFileSync(badPath, JSON.stringify(bad));
    // 坏档二：截断 JSON（parse 在读层就抛，无 errno code，同走降级）。
    fs.writeFileSync(path.join(dir, 'exp-test-0002.json'), '{"id": "exp-test-0002", "trunc');

    // 修复前：Promise.all 整体 rejects（一条坏档炸掉整个经验页）；
    // 修复后：坏条目跳过、好条目照常返回（此处两条都坏了 → 空列表不炸）。
    await expect(service.listExperiences(UID)).resolves.toEqual([]);

    // 再补一条好经验：好条目在坏档共存时照常列出（降级不吞好数据）。
    await service.createExperience(UID, variantExperience({ id: 'exp-test-0003', episode: 'kse-ep-0003' }));
    const listed = await service.listExperiences(UID);
    expect(listed.map((item) => item.id)).toEqual(['exp-test-0003']);
  });

  it('rejects an id without the exp- prefix and writes nothing', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, baseExperience()))
      .resolves.toBeDefined();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      id: 'aa-foreign-1',
      learningProvenance: { ...baseExperience().learningProvenance },
    })).rejects.toThrow(/invalid experience id/);
    // 非法 id 不得落库（隔离边界：资产前缀的记录进不了经验集合）。
    expect(await service.listExperiences(UID)).toHaveLength(1);
    await expect(service.readExperience(UID, 'aa-foreign-1')).rejects.toThrow(/invalid experience id/);
  });

  it('rejects a record with empty evidenceRefs', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      evidenceRefs: [],
    })).rejects.toThrow(/evidenceRefs/);
    expect(await service.readExperience(UID, 'exp-test-0001')).toBeUndefined();
  });

  it('rejects an experienceType outside the closed set', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      experienceType: 'insight' as never,
    })).rejects.toThrow(/experienceType/);
    expect(await service.listExperiences(UID)).toHaveLength(0);
  });

  it('rejects overlong body (>4000) and title (>200)', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      body: '长'.repeat(4_001),
    })).rejects.toThrow(/body exceeds/);
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      title: '题'.repeat(201),
    })).rejects.toThrow(/title exceeds/);
    expect(await service.listExperiences(UID)).toHaveLength(0);
  });

  it('rejects applicableWhen/forbiddenWhen over 5 entries or 300 chars per entry', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      applicableWhen: ['一', '二', '三', '四', '五', '六'],
    })).rejects.toThrow(/applicableWhen exceeds 5 entries/);
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      applicableWhen: ['范'.repeat(301)],
    })).rejects.toThrow(/applicableWhen entry exceeds/);
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      forbiddenWhen: ['禁'.repeat(301)],
    })).rejects.toThrow(/forbiddenWhen entry exceeds/);
    expect(await service.listExperiences(UID)).toHaveLength(0);
  });

  it('rejects provenance that disagrees with source.episodeId', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      learningProvenance: {
        ...baseExperience().learningProvenance,
        episodeId: 'kse-ep-9999',
      },
    })).rejects.toThrow(/must match source\.episodeId/);
    expect(await service.readExperience(UID, 'exp-test-0001')).toBeUndefined();
  });

  it('rejects invalid status / taskType / verification shape', async () => {
    const service = await setup();
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      status: 'revoked' as never,
    })).rejects.toThrow(/status/);
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      source: { ...baseExperience().source, taskType: 'ops' as never },
    })).rejects.toThrow(/source\.taskType/);
    await expect(service.createExperience(UID, {
      ...baseExperience(),
      verification: { ...baseExperience().verification, state: 'verified' as never },
    })).rejects.toThrow(/verification\.state/);
    expect(await service.listExperiences(UID)).toHaveLength(0);
  });
});

describe('experience store round-trip (T004)', () => {
  it('create is idempotent on the same id and update goes through validation', async () => {
    const service = await setup();
    const first = await service.createExperience(UID, baseExperience());
    const again = await service.createExperience(UID, {
      ...baseExperience(),
      title: '第二次写入不应覆盖',
    });
    // 幂等：同 id 已存在时返回既有记录。
    expect(again.title).toBe(first.title);

    const updated = await service.updateExperience(UID, 'exp-test-0001', (current) => ({
      ...current,
      status: 'paused',
      updatedAt: new Date().toISOString(),
    }));
    expect(updated.status).toBe('paused');

    // update 路径同样过语义校验：坏字段进不了盘。
    await expect(service.updateExperience(UID, 'exp-test-0001', (current) => ({
      ...current,
      body: '坏'.repeat(4_001),
    }))).rejects.toThrow(/body exceeds/);
    const reread = await service.readExperience(UID, 'exp-test-0001');
    expect(reread?.status).toBe('paused');
    expect(reread?.body).toBe(baseExperience().body);
  });

  it('lists by updatedAt descending and tolerates an empty store', async () => {
    const service = await setup();
    expect(await service.listExperiences(UID)).toEqual([]);
    const later = new Date(Date.now() + 5_000).toISOString();
    await service.createExperience(UID, baseExperience());
    await service.createExperience(UID, {
      ...baseExperience(),
      id: 'exp-test-0002',
      source: { ...baseExperience().source, episodeId: 'kse-ep-0002', taskType: 'report', taskGoal: '写季度总结报告' },
      learningProvenance: { ...baseExperience().learningProvenance, episodeId: 'kse-ep-0002' },
      createdAt: later,
      updatedAt: later,
    });
    const listed = await service.listExperiences(UID);
    expect(listed.map((item) => item.id)).toEqual(['exp-test-0002', 'exp-test-0001']);
  });
});

describe('experience runtime eligibility adapter (T006)', () => {
  it('reuses the asset gate: paused -> status_not_active', async () => {
    const service = await setup();
    const gate = await import('../../../../src/main/features/recall/formal-assets/runtime');
    const paused = await service.createExperience(UID, {
      ...baseExperience(),
      status: 'paused',
    });
    const context = { taskText: '修复一个线上 bug' };
    const viaExperience = service.evaluateExperienceRuntimeEligibility(UID, paused, context);
    const viaGate = gate.evaluateAssetRuntimeEligibility(service.experienceRuntimeCandidate(paused), context);
    expect(viaExperience.eligible).toBe(false);
    expect(viaExperience.reasons).toContain('status_not_active');
    // 与直接调资产闸门逐条一致（适配器不复制判定，只做形状转换）。
    expect(viaExperience.reasons).toEqual(viaGate.reasons);
    expect(viaExperience.mode).toBe(viaGate.mode);
  });

  it('reuses the asset gate: scope mismatch on silent default injection', async () => {
    const service = await setup();
    const gate = await import('../../../../src/main/features/recall/formal-assets/runtime');
    const exp = await service.createExperience(UID, baseExperience());
    const context = { silentDefaultInjection: true as const, scope: 'report' };
    const viaExperience = service.evaluateExperienceRuntimeEligibility(UID, exp, context);
    const viaGate = gate.evaluateAssetRuntimeEligibility(service.experienceRuntimeCandidate(exp), context);
    expect(viaExperience.eligible).toBe(false);
    expect(viaExperience.reasons).toContain('scope_mismatch');
    expect(viaExperience.reasons).toEqual(viaGate.reasons);
  });

  it('reuses the asset gate: forbiddenWhen hit -> forbidden_context', async () => {
    const service = await setup();
    const gate = await import('../../../../src/main/features/recall/formal-assets/runtime');
    const exp = await service.createExperience(UID, {
      ...baseExperience(),
      forbiddenWhen: ['对外公开分享'],
    });
    const context = { taskText: '准备对外公开分享的材料' };
    const viaExperience = service.evaluateExperienceRuntimeEligibility(UID, exp, context);
    const viaGate = gate.evaluateAssetRuntimeEligibility(service.experienceRuntimeCandidate(exp), context);
    expect(viaExperience.eligible).toBe(false);
    expect(viaExperience.reasons).toContain('forbidden_context');
    expect(viaExperience.reasons).toEqual(viaGate.reasons);
  });

  it('reuses the asset gate: a healthy active experience is eligible', async () => {
    const service = await setup();
    const gate = await import('../../../../src/main/features/recall/formal-assets/runtime');
    const exp = await service.createExperience(UID, baseExperience());
    const context = { taskText: '修复登录函数的缺陷' };
    const viaExperience = service.evaluateExperienceRuntimeEligibility(UID, exp, context);
    const viaGate = gate.evaluateAssetRuntimeEligibility(service.experienceRuntimeCandidate(exp), context);
    expect(viaExperience.eligible).toBe(true);
    expect(viaExperience.reasons).toEqual([]);
    expect(viaExperience.mode).toBe(viaGate.mode);
    expect(viaExperience.usePolicy).toBe(viaGate.usePolicy);
  });

  it('treats merged as a terminal non-active status and refuses foreign owners', async () => {
    const service = await setup();
    const gate = await import('../../../../src/main/features/recall/formal-assets/runtime');
    const merged = await service.createExperience(UID, {
      ...baseExperience(),
      status: 'merged',
      mergedIntoExperienceId: 'exp-test-0009',
    });
    const result = service.evaluateExperienceRuntimeEligibility(UID, merged);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('status_not_active');
    const viaGate = gate.evaluateAssetRuntimeEligibility(service.experienceRuntimeCandidate(merged));
    expect(result.reasons).toEqual(viaGate.reasons);

    // 隔离也按属主：别人的经验不得被判定为可用。
    expect(() => service.evaluateExperienceRuntimeEligibility('user-other', merged))
      .toThrow(/owner mismatch/);
  });
});

describe('experience status toggle (T028, E3)', () => {
  it('pauses and resumes with exactly one ledger entry each (actor user, from/to)', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());

    const paused = await service.setExperienceStatus(UID, 'exp-test-0001', 'pause', '先停用观察');
    expect(paused.status).toBe('paused');
    expect(paused.history).toHaveLength(1);
    expect(paused.history![0]).toMatchObject({
      actor: 'user',
      action: 'paused',
      from: 'active',
      to: 'paused',
      reason: '先停用观察',
    });

    const resumed = await service.setExperienceStatus(UID, 'exp-test-0001', 'resume');
    expect(resumed.status).toBe('active');
    expect(resumed.history).toHaveLength(2);
    expect(resumed.history![1]).toMatchObject({ actor: 'user', action: 'resumed', from: 'paused', to: 'active' });
  });

  it('is idempotent when already in the target status: no duplicate ledger', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());
    await service.setExperienceStatus(UID, 'exp-test-0001', 'pause');
    const again = await service.setExperienceStatus(UID, 'exp-test-0001', 'pause');
    expect(again.status).toBe('paused');
    expect(again.history).toHaveLength(1);
  });

  it('refuses terminal states (archived / merged) with a clear error', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-m-a', status: 'archived' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-m-b', status: 'merged', episode: 'kse-m-b' }));
    await expect(service.setExperienceStatus(UID, 'exp-m-a', 'pause')).rejects.toThrow(/archived experience is terminal/);
    await expect(service.setExperienceStatus(UID, 'exp-m-b', 'resume')).rejects.toThrow(/merged experience is terminal/);
  });

  it('rejects an invalid action or note shape', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());
    await expect(service.setExperienceStatus(UID, 'exp-test-0001', 'freeze' as never)).rejects.toThrow(/invalid experience status action/);
    await expect(service.setExperienceStatus(UID, 'exp-test-0001', 'pause', 'x'.repeat(1_001))).rejects.toThrow(/invalid experience status note/);
    const untouched = await service.readExperience(UID, 'exp-test-0001');
    expect(untouched?.history).toBeUndefined();
  });
});

describe('experience type adjustment (T028, E4)', () => {
  it('round-trips the type with ledger from/to and leaves every other field alone', async () => {
    const service = await setup();
    const created = await service.createExperience(UID, baseExperience());

    const asGap = await service.setExperienceType(UID, 'exp-test-0001', 'gap', '其实是个缺口');
    expect(asGap.experienceType).toBe('gap');
    const backToLesson = await service.setExperienceType(UID, 'exp-test-0001', 'lesson');
    expect(backToLesson.experienceType).toBe('lesson');

    expect(backToLesson.history).toHaveLength(2);
    expect(backToLesson.history![0]).toMatchObject({ action: 'type_changed', from: 'lesson', to: 'gap', reason: '其实是个缺口' });
    expect(backToLesson.history![1]).toMatchObject({ action: 'type_changed', from: 'gap', to: 'lesson' });
    // 不自动改其他字段：正文/范围/状态/证据原样。
    expect(backToLesson.body).toBe(created.body);
    expect(backToLesson.scope).toBe(created.scope);
    expect(backToLesson.status).toBe('active');
    expect(backToLesson.evidenceRefs).toEqual(created.evidenceRefs);
  });

  it('accepts uncategorized both as source and as target', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-m-c', experienceType: 'uncategorized' }));
    const asWorkflow = await service.setExperienceType(UID, 'exp-m-c', 'workflow');
    expect(asWorkflow.experienceType).toBe('workflow');
    const back = await service.setExperienceType(UID, 'exp-m-c', 'uncategorized');
    expect(back.experienceType).toBe('uncategorized');
    expect(back.history!.map((entry) => `${entry.from}->${entry.to}`)).toEqual(['uncategorized->workflow', 'workflow->uncategorized']);
  });

  it('rejects an unknown type and terminal experiences', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());
    await service.createExperience(UID, variantExperience({ id: 'exp-m-d', status: 'archived', episode: 'kse-m-d' }));
    await expect(service.setExperienceType(UID, 'exp-test-0001', 'insight' as never)).rejects.toThrow(/invalid experience type/);
    await expect(service.setExperienceType(UID, 'exp-m-d', 'gap')).rejects.toThrow(/archived experience is terminal/);
  });
});

describe('experience merge (T028, E5)', () => {
  it('folds source provenance and evidence into target mergedFrom and keeps both records', async () => {
    const service = await setup();
    const source = await service.createExperience(UID, variantExperience({
      id: 'exp-mg-a',
      episode: 'kse-mg-a',
      title: '被合并的经验',
      body: '被合并的正文。',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-mg-a' }, { kind: 'artifact_file', id: 'file-mg-a' }],
    }));
    await service.createExperience(UID, variantExperience({ id: 'exp-mg-b', episode: 'kse-mg-b' }));

    const merged = await service.mergeExperiences(UID, 'exp-mg-a', 'exp-mg-b', '同一件事的两次沉淀');
    expect(merged.target.mergedFrom).toHaveLength(1);
    // 来源任务与证据引用原样冻结进 target（AC1：不丢证据）。
    expect(merged.target.mergedFrom![0]).toMatchObject({
      id: 'exp-mg-a',
      title: '被合并的经验',
      mergedAt: expect.any(String) as unknown as string,
    });
    expect(merged.target.mergedFrom![0].source).toEqual(source.source);
    expect(merged.target.mergedFrom![0].evidenceRefs).toEqual(source.evidenceRefs);
    expect(merged.target.history).toHaveLength(1);
    expect(merged.target.history![0]).toMatchObject({ actor: 'user', action: 'merged_from', from: 'exp-mg-a', reason: '同一件事的两次沉淀' });

    // source 置终态 + 记去向，不物理删除（title/body 仍在盘上）。
    const sourceAfter = await service.readExperience(UID, 'exp-mg-a');
    expect(sourceAfter?.status).toBe('merged');
    expect(sourceAfter?.mergedIntoExperienceId).toBe('exp-mg-b');
    expect(sourceAfter?.title).toBe('被合并的经验');
    expect(sourceAfter?.body).toBe('被合并的正文。');
    expect(sourceAfter?.history).toHaveLength(1);
    expect(sourceAfter?.history![0]).toMatchObject({ actor: 'user', action: 'merged', from: 'active', to: 'merged' });
  });

  it('keeps the full lineage across chained merges (A→B then B→C)', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-ch-a', episode: 'kse-ch-a' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-ch-b', episode: 'kse-ch-b' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-ch-c', episode: 'kse-ch-c' }));
    await service.mergeExperiences(UID, 'exp-ch-a', 'exp-ch-b');
    await service.mergeExperiences(UID, 'exp-ch-b', 'exp-ch-c');
    const target = await service.readExperience(UID, 'exp-ch-c');
    // 辈分不丢：C 能同时取回 A 与 B 的来源。
    expect(target?.mergedFrom!.map((entry) => entry.id)).toEqual(['exp-ch-a', 'exp-ch-b']);
  });

  it('rejects cross-type merges without touching either record', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-xt-a', episode: 'kse-xt-a', experienceType: 'lesson' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-xt-b', episode: 'kse-xt-b', experienceType: 'gap' }));
    await expect(service.mergeExperiences(UID, 'exp-xt-a', 'exp-xt-b')).rejects.toThrow(/same experienceType/);
    const a = await service.readExperience(UID, 'exp-xt-a');
    const b = await service.readExperience(UID, 'exp-xt-b');
    expect(a?.status).toBe('active');
    expect(b?.status).toBe('active');
    expect(b?.mergedFrom).toBeUndefined();
    expect(b?.history).toBeUndefined();
  });

  it('rejects repeat and self merges with an explanatory error, no duplicate ledger', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-rm-a', episode: 'kse-rm-a' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-rm-b', episode: 'kse-rm-b' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-rm-c', episode: 'kse-rm-c' }));
    await service.mergeExperiences(UID, 'exp-rm-a', 'exp-rm-b');

    await expect(service.mergeExperiences(UID, 'exp-rm-a', 'exp-rm-b')).rejects.toThrow(/already been merged into exp-rm-b/);
    await expect(service.mergeExperiences(UID, 'exp-rm-a', 'exp-rm-c')).rejects.toThrow(/already been merged into exp-rm-b/);
    await expect(service.mergeExperiences(UID, 'exp-rm-b', 'exp-rm-b')).rejects.toThrow(/into itself/);

    const target = await service.readExperience(UID, 'exp-rm-b');
    expect(target?.mergedFrom).toHaveLength(1);
    expect(target?.history!.filter((entry) => entry.action === 'merged_from')).toHaveLength(1);
  });

  it('refuses merging into or from a terminal experience', async () => {
    const service = await setup();
    await service.createExperience(UID, variantExperience({ id: 'exp-tm-a', episode: 'kse-tm-a' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-tm-b', episode: 'kse-tm-b', status: 'archived' }));
    await expect(service.mergeExperiences(UID, 'exp-tm-a', 'exp-tm-b')).rejects.toThrow(/archived experience is terminal/);
    await expect(service.mergeExperiences(UID, 'exp-tm-b', 'exp-tm-a')).rejects.toThrow(/archived experience is terminal/);
  });
});

describe('experience archive (T028, E6)', () => {
  it('requires a reason: missing / blank / overlong reason writes nothing', async () => {
    const service = await setup();
    await service.createExperience(UID, baseExperience());
    await expect(service.archiveExperience(UID, 'exp-test-0001', '')).rejects.toThrow(/invalid experience archive reason/);
    await expect(service.archiveExperience(UID, 'exp-test-0001', undefined as unknown as string)).rejects.toThrow(/invalid experience archive reason/);
    await expect(service.archiveExperience(UID, 'exp-test-0001', '因'.repeat(1_001))).rejects.toThrow(/invalid experience archive reason/);
    // 不落库：记录原样，没有 archivedAt 也没有台账。
    const untouched = await service.readExperience(UID, 'exp-test-0001');
    expect(untouched?.status).toBe('active');
    expect(untouched?.archivedAt).toBeUndefined();
    expect(untouched?.history).toBeUndefined();
  });

  it('archives with archivedAt + traceable ledger, drops out of the catalog, stays readable', async () => {
    const service = await setup();
    const keep = '留下来的经验正文。KEEP-BODY';
    const drop = '被归档的经验正文。DROP-BODY';
    await service.createExperience(UID, variantExperience({ id: 'exp-ar-keep', episode: 'kse-ar-keep', body: keep }));
    await service.createExperience(UID, variantExperience({ id: 'exp-ar-drop', episode: 'kse-ar-drop', body: drop }));

    const archived = await service.archiveExperience(UID, 'exp-ar-drop', '已过期不再适用');
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toEqual(expect.any(String) as unknown as string);
    expect(archived.archiveReason).toBe('已过期不再适用');
    expect(archived.history!.at(-1)).toMatchObject({ action: 'archived', from: 'active', to: 'archived', reason: '已过期不再适用' });

    // 准入面立即生效：status_not_active（下一轮清单/@ 带入同判据）。
    const dropped = await service.readExperience(UID, 'exp-ar-drop');
    expect(service.evaluateExperienceRuntimeEligibility(UID, dropped!).reasons).toContain('status_not_active');

    // 清单零出现：目录只收 active，归档条目 id 与正文都不出现；active 条目仍在。
    const similarity = await import('../../../../src/main/features/recall/similarity');
    similarity.clearEmbedCacheForTest();
    similarity._injectEmbeddingForTest(UID, '修复登录函数的缺陷', [1, 0]);
    similarity._injectEmbeddingForTest(UID, keep, [1, 0]);
    const catalog = await import('../../../../src/main/features/recall/experience-catalog');
    const built = await catalog.buildExperienceCatalog(UID, '修复登录函数的缺陷');
    expect(built.entries.map((entry) => entry.id)).toEqual(['exp-ar-keep']);
    expect(built.text).not.toContain('exp-ar-drop');
    expect(built.text).not.toContain('DROP-BODY');

    // 已冻结的引用语义：记录本身仍可读（不物理删除）。
    expect(dropped?.title).toBeDefined();
    // 再次归档是终态拒绝。
    await expect(service.archiveExperience(UID, 'exp-ar-drop', '再归档一次')).rejects.toThrow(/archived experience is terminal/);
  });
});

describe('management actions leave the asset store untouched (T028, FR-006)', () => {
  it('listAbilityAssets is identical before and after every management action', async () => {
    const service = await setup();
    const assetService = await import('../../../../src/main/features/recall/asset-service');
    await service.createExperience(UID, variantExperience({ id: 'exp-az-a', episode: 'kse-az-a' }));
    await service.createExperience(UID, variantExperience({ id: 'exp-az-b', episode: 'kse-az-b' }));
    const before = await assetService.listAbilityAssets(UID);

    await service.setExperienceStatus(UID, 'exp-az-a', 'pause');
    await service.setExperienceStatus(UID, 'exp-az-a', 'resume');
    await service.mergeExperiences(UID, 'exp-az-a', 'exp-az-b');
    // 合并后 target 仍是活记录，可继续调类型与归档（全部管理动作都在经验集合内）。
    await service.setExperienceType(UID, 'exp-az-b', 'gap');
    await service.archiveExperience(UID, 'exp-az-b', '清理口径');

    // 双向隔离：经验侧的全部管理动作之后，资产库逐字不变。
    const after = await assetService.listAbilityAssets(UID);
    expect(after).toEqual(before);
    expect(after).toHaveLength(0);
  });
});
