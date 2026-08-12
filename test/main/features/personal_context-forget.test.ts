/**
 * personal_context/forget — 按范围遗忘：scope 文法解析（纯函数）、
 * 注册表/候选匹配（纯函数）、预览与执行（tmp 目录集成）。
 *
 * 集成部分通过真实 registry/candidates 存储验证：
 *   - 预览只读不落盘；执行 = 注册表标记失效（保留）+ 候选驳回 + 游标重置
 *   - 幂等：重复执行同 scope 不扩大影响面
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildResourceKey } from '../../../src/main/features/personal_context/contract';

const UID = 'forget-unit-user';
let tmpDir = '';
let prevWs = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forget-test-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT || '';
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadForget() {
  return import('../../../src/main/features/personal_context/forget');
}

async function loadRegistry() {
  return import('../../../src/main/features/personal_context/registry');
}

async function loadCandidates() {
  return import('../../../src/main/features/personal_ontology_candidates');
}

function candidatesMdPath(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

async function seedRegistry(resources: Array<{ key: string; type: string; title: string; observedAt: string }>) {
  const { PersonalContextRegistry } = await loadRegistry();
  const store = new PersonalContextRegistry();
  for (const r of resources) {
    await store.upsert(UID, {
      resourceId: r.key,
      resourceType: r.type as never,
      title: r.title,
      observedAt: r.observedAt,
      accessLabel: 'personal',
      retentionPolicy: 'source-linked',
    } as never);
  }
  return store;
}

async function seedCandidates(updates: Array<{ id: string; refs: string[] }>) {
  const { serializeCandidatesMarkdown } = await loadCandidates();
  const md = serializeCandidatesMarkdown(updates.map((u) => ({
    candidate_id: u.id,
    kind: 'instance' as const,
    confidence: 'high' as const,
    summary: u.id,
    memory_scope: 'user' as const,
    source_memory_refs: u.refs,
  })));
  fs.mkdirSync(path.dirname(candidatesMdPath()), { recursive: true });
  fs.writeFileSync(candidatesMdPath(), md, 'utf8');
}

// ── parseForgetScope（纯函数）────────────────────────────────────────────

describe('forget › parseForgetScope', () => {
  it('接受全量、provider 级、类型级、单资源与 since 文法', async () => {
    const { parseForgetScope } = await loadForget();
    expect(parseForgetScope('all')).toEqual({ ok: true, scope: { all: true } });
    expect(parseForgetScope('feishu:all')).toEqual({ ok: true, scope: { all: true, provider: 'feishu' } });
    expect(parseForgetScope('feishu')).toEqual({ ok: true, scope: { all: false, provider: 'feishu' } });
    expect(parseForgetScope('feishu:calendar')).toEqual({ ok: true, scope: { all: false, provider: 'feishu', types: ['calendar'] } });
    expect(parseForgetScope('feishu:calendar:cal_xxx')).toEqual({
      ok: true, scope: { all: false, provider: 'feishu', types: ['calendar'], resourceStableId: 'cal_xxx' },
    });
    expect(parseForgetScope('feishu:calendar:since:2026-07-01')).toEqual({
      ok: true, scope: { all: false, provider: 'feishu', types: ['calendar'], since: '2026-07-01' },
    });
    expect(parseForgetScope('feishu:since:2026-07-01')).toEqual({
      ok: true, scope: { all: false, provider: 'feishu', since: '2026-07-01' },
    });
  });

  it('拒绝空参数、未知 provider/类型、非法 id 与多余段', async () => {
    const { parseForgetScope } = await loadForget();
    expect(parseForgetScope('').ok).toBe(false);
    expect(parseForgetScope('   ').ok).toBe(false);
    expect(parseForgetScope('wechat:calendar').ok).toBe(false);
    expect(parseForgetScope('feishu:bogus').ok).toBe(false);
    expect(parseForgetScope('feishu:calendar:bad id').ok).toBe(false);
    expect(parseForgetScope('feishu:since:not-a-date').ok).toBe(false);
    expect(parseForgetScope('feishu:calendar:since:2026-07-01:extra').ok).toBe(false);
    expect(parseForgetScope('feishu:calendar:cal_a:extra').ok).toBe(false);
  });
});

// ── 匹配计算（纯函数）────────────────────────────────────────────────────

describe('forget › 匹配计算', () => {
  it('matchRegistryEntries 按 provider/type/stableId/since 过滤', async () => {
    const { matchRegistryEntries } = await loadForget();
    const entries = [
      { resource: { resourceId: buildResourceKey('feishu', 't1', 'calendar', 'cal_a'), observedAt: '2026-08-01T00:00:00Z' } },
      { resource: { resourceId: buildResourceKey('feishu', 't1', 'calendar', 'cal_b'), observedAt: '2026-07-01T00:00:00Z' } },
      { resource: { resourceId: buildResourceKey('feishu', 't1', 'document', 'doc_x'), observedAt: '2026-08-01T00:00:00Z' } },
    ] as never as Array<import('../../../src/main/features/personal_context/registry').RegistryEntry>;

    expect(matchRegistryEntries(entries, { all: true })).toHaveLength(3);
    expect(matchRegistryEntries(entries, { all: false, provider: 'feishu', types: ['calendar'] })).toHaveLength(2);
    expect(matchRegistryEntries(entries, { all: false, provider: 'feishu', types: ['calendar'], resourceStableId: 'cal_a' })).toHaveLength(1);
    expect(matchRegistryEntries(entries, { all: false, provider: 'feishu', since: '2026-08-01' })).toHaveLength(2);
  });

  it('matchCandidatesForScope 按来源引用前缀过滤', async () => {
    const { matchCandidatesForScope } = await loadForget();
    const candidates = [
      { candidate_id: 'c1', source_memory_refs: ['feishu:t1:calendar:cal_a/event-1'] },
      { candidate_id: 'c2', source_memory_refs: ['feishu:t1:document:doc_x/section'] },
      { candidate_id: 'c3', source_memory_refs: ['other-provider:x'] },
    ] as never as Array<import('../../../src/main/features/personal_ontology_candidates').CandidateUpdate>;

    expect(matchCandidatesForScope(candidates, { all: true })).toHaveLength(3);
    expect(matchCandidatesForScope(candidates, { all: false, provider: 'feishu' })).toHaveLength(2);
    expect(matchCandidatesForScope(candidates, { all: false, provider: 'feishu', resourceStableId: 'cal_a' })).toHaveLength(1);
    expect(matchCandidatesForScope(candidates, { all: false, provider: 'feishu', types: ['document'] })).toHaveLength(1);
  });

  it('describeScope 输出可读范围描述', async () => {
    const { describeScope } = await loadForget();
    expect(describeScope({ all: true })).toBe('all');
    expect(describeScope({ all: false, provider: 'feishu', types: ['calendar'] })).toBe('feishu:calendar');
    expect(describeScope({ all: false, provider: 'feishu', types: ['calendar'], resourceStableId: 'cal_a', since: '2026-07-01' }))
      .toBe('feishu:calendar:cal_a:since:2026-07-01');
  });
});

// ── 预览 / 执行（集成）───────────────────────────────────────────────────

describe('forget › preview/execute', () => {
  it('预览只读；执行后注册表标记失效、候选驳回、游标重置，且幂等', async () => {
    const forget = await loadForget();
    const registry = await loadRegistry();
    await seedRegistry([
      { key: buildResourceKey('feishu', 't1', 'calendar', 'cal_a'), type: 'calendar', title: '主日历', observedAt: '2026-08-01T00:00:00Z' },
      { key: buildResourceKey('feishu', 't1', 'calendar', 'cal_b'), type: 'calendar', title: '课程日历', observedAt: '2026-08-01T00:00:00Z' },
      { key: buildResourceKey('feishu', 't1', 'document', 'doc_x'), type: 'document', title: '课程资料', observedAt: '2026-08-01T00:00:00Z' },
    ]);
    await seedCandidates([
      { id: 'cand_cal', refs: ['feishu:t1:calendar:cal_a/event-1'] },
      { id: 'cand_doc', refs: ['feishu:t1:document:doc_x/section-1'] },
    ]);
    // 游标文件（模拟已同步的 feishu provider）
    const cursorDir = path.join(tmpDir, UID, 'cloud', 'context', 'cursors');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'feishu.json'), JSON.stringify({
      version: 1,
      providerId: 'feishu',
      cursor: { watermarks: { calendar_event: '2026-08-01T00:00:00Z' }, eventIdempotency: ['ev_1'], updatedAt: '2026-08-01T00:00:00Z' },
    }));

    const scope = { all: false, provider: 'feishu', types: ['calendar'] as const };
    const preview = await forget.previewForget(UID, scope);
    expect(preview.scopeKey).toBe('feishu:calendar');
    expect(preview.counts.resources).toBe(2);
    expect(preview.counts.candidates).toBe(1);
    expect(preview.counts.cursorProviders).toBe(1);
    // 预览不落盘：资源仍未失效
    const store = new registry.PersonalContextRegistry();
    expect((await store.list(UID, { types: ['calendar'], includeInvalid: true })).filter((e) => e.invalidatedAt)).toHaveLength(0);

    const result = await forget.executeForget(UID, scope);
    expect(result).toEqual({
      scopeKey: 'feishu:calendar',
      invalidatedResources: 2,
      rejectedCandidates: 1,
      resetCursors: ['feishu'],
    });

    // 注册表：匹配资源已失效（保留但不可见），未匹配资源不受影响
    const calendar = await store.list(UID, { types: ['calendar'], includeInvalid: true });
    expect(calendar.filter((e) => e.invalidatedAt)).toHaveLength(2);
    expect(await store.list(UID, { types: ['calendar'] })).toHaveLength(0);
    const docs = await store.list(UID, { types: ['document'], includeInvalid: true });
    expect(docs).toHaveLength(1);
    expect(docs[0].invalidatedAt).toBeUndefined();

    // 候选：来源匹配的被驳回，不匹配的保留
    const candidates = await loadCandidates();
    const remaining = await candidates.listCandidates(UID);
    expect(remaining.candidate_updates.map((c) => c.candidate_id)).toEqual(['cand_doc']);

    // 游标：已重置为空
    const cursorStore = new registry.PersonalContextCursorStore();
    const cursor = await cursorStore.get(UID, 'feishu');
    expect(cursor?.watermarks).toEqual({});
    expect(cursor?.eventIdempotency).toEqual([]);

    // 幂等：再次执行同 scope 不扩大影响面
    const again = await forget.executeForget(UID, scope);
    expect(again.invalidatedResources).toBe(0);
    expect(again.rejectedCandidates).toBe(0);
  });

  it('all 范围影响全部 provider 资源与候选', async () => {
    const forget = await loadForget();
    await seedRegistry([
      { key: buildResourceKey('feishu', 't1', 'calendar', 'cal_a'), type: 'calendar', title: '主日历', observedAt: '2026-08-01T00:00:00Z' },
      { key: buildResourceKey('feishu', 't1', 'document', 'doc_x'), type: 'document', title: '资料', observedAt: '2026-08-01T00:00:00Z' },
    ]);
    await seedCandidates([
      { id: 'cand_1', refs: ['feishu:t1:calendar:cal_a/event-1'] },
      { id: 'cand_2', refs: ['feishu:t1:document:doc_x/section'] },
    ]);

    const preview = await forget.previewForget(UID, { all: true });
    expect(preview.counts.resources).toBe(2);
    expect(preview.counts.candidates).toBe(2);

    const result = await forget.executeForget(UID, { all: true });
    expect(result.invalidatedResources).toBe(2);
    expect(result.rejectedCandidates).toBe(2);
  });
});
