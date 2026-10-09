import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// addCandidate 写本体候选池经 personal_ontology_candidates → groups 存储链，
// 与 candidates.test.ts 同款 mock，避免拉起 fastembed/sqlite-vec。
vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-backflow';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-backflow-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadBackflow() {
  return import('../../../../src/main/features/recall/ontology-backflow');
}

async function loadPoc() {
  return import('../../../../src/main/features/personal_ontology_candidates');
}

interface FakeAsset {
  id: string;
  type: 'personal' | 'rule' | 'template' | 'skill_method';
  statement: string;
  title: string;
}

function fakeAsset(overrides: Partial<FakeAsset> = {}): FakeAsset {
  return {
    id: 'aa-backflow-1',
    type: 'personal',
    statement: '偏好中文简洁回复。',
    title: '回复语言偏好',
    ...overrides,
  };
}

async function backflowIds(): Promise<string[]> {
  const poc = await loadPoc();
  const pool = await poc.listCandidates(UID);
  return (pool.candidate_updates || [])
    .map((c) => c.candidate_id)
    .filter((id) => id.startsWith('asset-backflow-'));
}

describe('ontology-backflow › whitelist and pool shape', () => {
  it('offers personal assets as preference/user with low confidence', async () => {
    const backflow = await loadBackflow();
    const outcome = await backflow.backflowAssetToOntologyPool(UID, fakeAsset());
    expect(outcome).toEqual({ offered: true, candidateId: 'asset-backflow-aa-backflow-1' });

    const poc = await loadPoc();
    const pool = await poc.listCandidates(UID);
    const entry = pool.candidate_updates.find((c) => c.candidate_id === 'asset-backflow-aa-backflow-1');
    expect(entry).toMatchObject({
      kind: 'preference',
      memory_scope: 'user',
      confidence: 'low',
      write_actor: 'llm',
      memory_text: '偏好中文简洁回复。',
    });
  });

  it('maps rule → rule/shared and template → instance/user', async () => {
    const backflow = await loadBackflow();
    await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ id: 'aa-rule', type: 'rule', statement: '评审先讲产品模型。' }));
    await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ id: 'aa-tpl', type: 'template', statement: '学生身份在读。' }));

    const poc = await loadPoc();
    const pool = await poc.listCandidates(UID);
    expect(pool.candidate_updates.find((c) => c.candidate_id === 'asset-backflow-aa-rule'))
      .toMatchObject({ kind: 'rule', memory_scope: 'shared' });
    expect(pool.candidate_updates.find((c) => c.candidate_id === 'asset-backflow-aa-tpl'))
      .toMatchObject({ kind: 'instance', memory_scope: 'user' });
  });

  it('never offers skill_method assets', async () => {
    const backflow = await loadBackflow();
    const outcome = await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ id: 'aa-skill', type: 'skill_method' }));
    expect(outcome).toEqual({ offered: false, reason: 'type_not_whitelisted' });
    expect(await backflowIds()).toEqual([]);
  });

  it('skips empty statements', async () => {
    const backflow = await loadBackflow();
    const outcome = await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ statement: '   ' }));
    expect(outcome).toEqual({ offered: false, reason: 'empty_statement' });
  });
});

describe('ontology-backflow › idempotency and flood guard', () => {
  it('re-offering the same asset overwrites instead of piling up', async () => {
    const backflow = await loadBackflow();
    await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ statement: '第一版内容。' }));
    await backflow.backflowAssetToOntologyPool(UID, fakeAsset({ statement: '第二版内容，覆盖第一版。' }));

    const ids = await backflowIds();
    expect(ids).toEqual(['asset-backflow-aa-backflow-1']);
    const poc = await loadPoc();
    const pool = await poc.listCandidates(UID);
    expect(pool.candidate_updates[0].memory_text).toBe('第二版内容，覆盖第一版。');
  });

  it('stops offering once the pool holds 20 backflow entries', async () => {
    const poc = await loadPoc();
    for (let i = 0; i < 20; i += 1) {
      await poc.addCandidate(UID, {
        candidate_id: `asset-backflow-aa-old-${i}`,
        kind: 'preference',
        memory_scope: 'user',
        summary: `存量回流 ${i}`,
        memory_text: `存量回流 ${i}`,
      });
    }
    const backflow = await loadBackflow();
    const outcome = await backflow.backflowAssetToOntologyPool(UID, fakeAsset());
    expect(outcome).toEqual({ offered: false, reason: 'pool_full' });
    // 原池 20 条原样保留，没有第 21 条
    expect((await backflowIds()).length).toBe(20);
  });
});

describe('ontology-backflow › wired into asset creation', () => {
  it('promoting a personal asset offers it to the pool end to end', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    const saved = await cs.saveRecallCandidate(UID, {
      judgment: '偏好用中文写周报。',
      suggestedType: 'personal',
      suggestedScope: 'general',
      sourceRefs: [{ kind: 'memory', id: 'backflow-e2e' }],
    });
    const { asset } = await cs.promoteRecallCandidate(UID, saved.id, { actor: 'user' });
    expect(asset?.type).toBe('personal');

    const ids = await backflowIds();
    expect(ids).toEqual([`asset-backflow-${asset!.id}`]);
  });

  it('skill_method promotion does not touch the pool', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    const saved = await cs.saveRecallCandidate(UID, {
      judgment: '先跑测试再提交的做法。',
      suggestedType: 'skill_method',
      suggestedScope: 'general',
      sourceRefs: [{ kind: 'memory', id: 'backflow-skill' }],
    });
    await cs.promoteRecallCandidate(UID, saved.id, { actor: 'user' });
    expect(await backflowIds()).toEqual([]);
  });
});
