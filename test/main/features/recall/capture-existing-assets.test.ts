import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
import { loadCaptureExistingAssetPool, selectCaptureExistingAssets } from '../../../../src/main/features/recall/capture-existing-assets';

const { list, readVersion, readableGate, embed } = vi.hoisted(() => ({ list: vi.fn(), readVersion: vi.fn(), readableGate: vi.fn(), embed: vi.fn() }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  listAbilityAssets: list, readAbilityAssetVersionSnapshot: readVersion,
}));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: readableGate }));
vi.mock('../../../../src/main/features/recall/similarity', () => ({ embedForDedup: embed,
  cosineScore: (a: number[], b: number[]) => a.reduce((value, part, index) => value + part * b[index], 0), SEMANTIC_RELATED_THRESHOLD: 0.7 }));
const user = 'comparison-user';
function asset(id: string, patch: Partial<RecallAbilityAssetRecord> = {}): RecallAbilityAssetRecord {
  return { schemaVersion: 1, ownerId: user, id, candidateId: 'candidate-' + id, reviewDecisionId: 'decision-' + id,
    type: 'cognition', title: 'Unrelated travel advice', statement: 'Pack travel accessories in advance.',
    evidenceRefs: [{ kind: 'conversation', id: 'source-' + id }], status: 'active',
    scope: 'general', version: '1', maturity: 'seed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', ...patch };
}
beforeEach(() => {
  list.mockReset(); readVersion.mockReset();
  embed.mockReset().mockResolvedValue(null);
  readableGate.mockReset().mockImplementation(async (_user: string, records: RecallAbilityAssetRecord[]) => records);
});

describe('nightly existing-cognition comparison context', () => {
  it('brings a differently worded relevant record into a limited comparison pool through full-body semantic ranking', async () => {
    list.mockResolvedValue([asset('paraphrase', { title: '交流结构', statement: '把关键判断放在长篇背景的前面。', updatedAt: '2025-01-01T00:00:00Z' }),
      asset('lexical-noise', { title: '结论与解释', statement: '这个标题只是历史术语，不提供表达要求。' })]);
    embed.mockImplementation(async (_user, text: string) => text.includes('这个标题') ? [0, 1] : [1, 0]);
    const result = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '说明复杂问题时结论应放在前面。' }], maxAssets: 1 });
    expect(result.assets.map(item => item.id)).toEqual(['paraphrase']);
    expect(result.coverage).toMatchObject({ truncated: true, semantic: 'complete' });
    expect(embed.mock.calls.some(([, text]) => text.includes('把关键判断放在长篇背景的前面。'))).toBe(true);
  });
  it('declares unavailable semantic selection and avoids embedding when all complete records already fit', async () => {
    list.mockResolvedValue([asset('a'), asset('b')]);
    const bounded = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '项目决策来源' }], maxAssets: 1 });
    expect(bounded.coverage.semantic).toBe('unavailable');
    embed.mockClear();
    const complete = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '项目决策来源' }] });
    expect(complete.coverage).toMatchObject({ truncated: false, semantic: 'not_needed' });
    expect(embed).not.toHaveBeenCalled();
  });
  it('searches all active records so an old relevant cognition precedes the latest twenty unrelated entries', async () => {
    const oldest = asset('old-rule', { title: '周报汇报顺序', statement: '项目周报先列风险，然后列进展和计划。', updatedAt: '2025-01-01T00:00:00Z' });
    list.mockResolvedValue([...Array.from({ length: 25 }, (_, i) => asset('recent-' + i)), oldest]);
    const result = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '项目周报顺序需要纠正：风险与计划要说明负责人。' }], maxAssets: 3 });
    expect(result.assets[0].id).toBe(oldest.id);
    expect(result.assets[0].statement).toBe(oldest.statement);
    expect(result.coverage).toEqual({ total: 26, selected: 3, truncated: true, unavailable: 0, semantic: 'unavailable' });
    expect(list).toHaveBeenCalledWith(user);
    expect(readVersion).not.toHaveBeenCalled();
  });
  it('uses summary topics and conditions and the entire stored body, including a relevant passage beyond catalog previews', async () => {
    const record = asset('deep-body', { title: '早期讨论结论', statement: '无关资料。'.repeat(300) + '预算报告使用成本中心核对口径。', updatedAt: '2024-01-01T00:00:00Z' });
    list.mockResolvedValue([asset('recent'), record]);
    const result = await selectCaptureExistingAssets(user, { summary: { topics: [{ title: '预算报告', content: '预算报告的成本中心核对口径需要补充。', conditions: ['成本中心核对'], unresolved: [], attribution: 'user_requirement', evidence: [] }] }, maxAssets: 1 });
    expect(result.assets[0].id).toBe(record.id);
    expect(result.assets[0].statement).toBe(record.statement);
  });
  it('count and character budgets omit complete records instead of truncating their content, reporting incomplete coverage', async () => {
    const oversized = asset('oversized', { title: '周报风险', statement: '周报风险'.repeat(1000) });
    const small = asset('small', { title: '周报风险的复用条件', statement: '只在项目周报中说明风险。' });
    list.mockResolvedValue([oversized, small]);
    const result = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '周报风险' }], maxChars: 700 });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].statement).toBe(small.statement);
    expect(result.assets[0].id).toBe(small.id);
    expect(JSON.stringify(result.assets).length).toBeLessThanOrEqual(700);
    expect(result.coverage).toMatchObject({ total: 2, selected: 1, truncated: true });
  });
  it('binds the comparison baseline to the full pool rather than the prompt budget', async () => {
    let current = [asset('a'), asset('b')];
    list.mockImplementation(async () => current);
    const limited = await selectCaptureExistingAssets(user, { maxAssets: 1 });
    const complete = await selectCaptureExistingAssets(user, { maxAssets: 100, maxChars: 96_000 });
    expect(complete.baselineDigest).toBe(limited.baselineDigest);
    current = [asset('a', { version: '2', activeVersion: '2', statement: 'A revised statement.' }), asset('b')];
    const revised = await selectCaptureExistingAssets(user);
    expect(revised.baselineDigest).not.toBe(limited.baselineDigest);
    current = current.slice(1);
    expect((await selectCaptureExistingAssets(user)).baselineDigest).not.toBe(revised.baselineDigest);
  });
  it('changes the baseline for each readable version, content, membership, status and access change', async () => {
    const initial = asset('baseline', { activeVersion: '1', version: '1', statement: 'Original body.' });
    let current = [initial, asset('peer')];
    list.mockImplementation(async () => current);
    const digest = async () => (await selectCaptureExistingAssets(user)).baselineDigest;
    const baseline = await digest();
    current = [asset('peer'), initial];
    expect(await digest()).toBe(baseline);
    current = [{ ...initial, activeVersion: '2', version: '2' }, asset('peer')];
    expect(await digest()).not.toBe(baseline);
    current = [{ ...initial, statement: 'Changed body at the same version.' }, asset('peer')];
    expect(await digest()).not.toBe(baseline);
    current = [{ ...initial, status: 'paused' }, asset('peer')];
    expect(await digest()).not.toBe(baseline);
    current = [{ ...initial, scopePolicy: { projectIds: ['other-project'] } }, asset('peer')];
    expect(await digest()).not.toBe(baseline);
    current = [initial, asset('replacement')];
    expect(await digest()).not.toBe(baseline);
    current = [initial, asset('peer')];
    readableGate.mockImplementation(async (_user: string, records: RecallAbilityAssetRecord[]) => records.filter(record => record.id !== initial.id));
    expect(await digest()).not.toBe(baseline);
    readableGate.mockImplementation(async (_user: string, records: RecallAbilityAssetRecord[]) => records);
    expect(await digest()).toBe(baseline);
  });
  it('binds unavailable active heads by identity, version and reason without adding their bodies to the selection', async () => {
    let current = [asset('unavailable-a', { version: '4', activeVersion: '1', statement: 'HEAD BODY MUST NOT BE SELECTED' })];
    list.mockImplementation(async () => current);
    readVersion.mockResolvedValue(null);
    const missing = await selectCaptureExistingAssets(user);
    expect(missing.assets).toEqual([]);
    expect(missing.coverage).toMatchObject({ total: 1, unavailable: 1, truncated: true });
    expect(JSON.stringify(missing)).not.toContain('HEAD BODY MUST NOT BE SELECTED');
    current = [asset('unavailable-b', { version: '4', activeVersion: '1' })];
    expect((await selectCaptureExistingAssets(user)).baselineDigest).not.toBe(missing.baselineDigest);
    current = [asset('unavailable-a', { version: '4', activeVersion: '2' })];
    expect((await selectCaptureExistingAssets(user)).baselineDigest).not.toBe(missing.baselineDigest);
    current = [asset('unavailable-a', { version: '4', activeVersion: '1' })];
    readVersion.mockResolvedValue({ statement: '' });
    expect((await selectCaptureExistingAssets(user)).baselineDigest).not.toBe(missing.baselineDigest);
    readVersion.mockResolvedValue({ statement: 'Available active body.', type: 'cognition', evidenceRefs: [] });
    const available = await selectCaptureExistingAssets(user);
    expect(available.coverage.unavailable).toBe(0);
    expect(available.baselineDigest).not.toBe(missing.baselineDigest);
  });
  it('loads a full baseline without query ranking or embeddings', async () => {
    list.mockResolvedValue(Array.from({ length: 25 }, (_, index) => asset(`baseline-${index}`)));
    const pool = await loadCaptureExistingAssetPool(user, { approvedEvidence: [{ quote: 'Pack travel accessories' }], maxAssets: 1, maxChars: 500 });
    expect(pool.entries).toHaveLength(25);
    expect(pool.total).toBe(25);
    expect(embed).not.toHaveBeenCalled();
  });
  it('reads the selected historical version while retaining the current authorization scope', async () => {
    const record = asset('historical', { activeVersion: '1', version: '3', title: '沟通顺序', statement: '当前计数对应的另一个快照', scopePolicy: { projectIds: ['project-a'] } });
    list.mockResolvedValue([record]);
    readVersion.mockResolvedValue({ title: '旧标题', statement: '解释复杂问题先给结论。', type: 'cognition', scope: 'review', evidenceRefs: [{ kind: 'conversation', id: 'active-version-source' }], applicableWhen: ['解释复杂问题'], scopePolicy: { projectIds: ['project-b'] } });
    const result = await selectCaptureExistingAssets(user, { sourceScope: { projectId: 'project-a' }, approvedEvidence: [{ quote: '解释复杂问题时补充依据' }] });
    expect(readVersion).toHaveBeenCalledWith(user, record.id, '1');
    expect(result.assets[0]).toMatchObject({ version: '1', statement: '解释复杂问题先给结论。', title: record.title,
      scope: 'general', scopePolicy: { projectIds: ['project-a'] }, evidenceRefs: [{ kind: 'conversation', id: 'active-version-source' }], applicableWhen: ['解释复杂问题'] });
    expect(result.coverage.truncated).toBe(false);
  });
  it('restricts comparison to current allowed source scope, fails closed for missing context, and does not disclose excluded identities or counts', async () => {
    list.mockResolvedValue([
      asset('global'), asset('same-project', { scopePolicy: { projectIds: ['project-a'] } }),
      asset('foreign-project', { scopePolicy: { projectIds: ['project-b'] } }),
      asset('deny-all', { scopePolicy: { workspaceIds: [] } }), asset('unknown-agent', { scopePolicy: { agentIds: ['special-agent'] } }),
      asset('paused', { status: 'paused' }), asset('deleted', { status: 'deleted' }), asset('other-user', { ownerId: 'another-user' }),
    ]);
    const absent = await selectCaptureExistingAssets(user);
    expect(absent.assets.map(a => a.id)).toEqual(['global']);
    expect(absent.coverage.total).toBe(1);
    const known = await selectCaptureExistingAssets(user, { sourceScope: { projectId: 'project-a' } });
    expect(known.assets.map(a => a.id)).toEqual(['global', 'same-project']);
    expect(known.coverage.total).toBe(2);
    expect(JSON.stringify(known)).not.toContain('foreign-project');
    list.mockResolvedValue([asset('purpose-restricted', { scopePolicy: { purposeTags: ['report'] } })]);
    expect((await selectCaptureExistingAssets(user, { sourceScope: { taskText: 'report weekly changes' } })).assets.map(a => a.id)).toEqual(['purpose-restricted']);
    expect((await selectCaptureExistingAssets(user, { sourceScope: { taskText: 'code fixes' } })).assets).toEqual([]);
  });
  it('missing active snapshots are omitted honestly; storage read failures propagate instead of pretending a complete empty pool', async () => {
    list.mockResolvedValue([asset('missing-active', { version: '3', activeVersion: '1' }), asset('readable')]);
    readVersion.mockResolvedValue(null);
    const result = await selectCaptureExistingAssets(user);
    expect(result.assets.map(a => a.id)).toEqual(['readable']);
    expect(result.coverage).toEqual({ total: 2, selected: 1, truncated: true, unavailable: 1, semantic: 'not_needed' });
    readVersion.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(selectCaptureExistingAssets(user)).rejects.toThrow('disk unavailable');
    list.mockRejectedValueOnce(new Error('master list unavailable'));
    await expect(selectCaptureExistingAssets(user)).rejects.toThrow('master list unavailable');
  });
  it('delegates source and runtime inspect admission, including the sources of a historical body, without disclosing blocked records', async () => {
    const restricted = asset('source-disabled', { evidenceRefs: [{ kind: 'conversation', id: 'paused-source' }] });
    const historical = asset('historical-disabled', { version: '3', activeVersion: '1' });
    list.mockResolvedValue([restricted, historical, asset('allowed')]);
    readVersion.mockResolvedValue({ statement: '旧正文', type: 'cognition', evidenceRefs: [{ kind: 'conversation', id: 'removed-source' }] });
    readableGate.mockImplementation(async (_user: string, records: RecallAbilityAssetRecord[]) => records.filter(record => record.evidenceRefs.every(ref => !['paused-source', 'removed-source'].includes(ref.id))));
    const result = await selectCaptureExistingAssets(user, { sourceScope: { projectId: 'project-a', workspaceId: 'workspace-a', conversationKind: 'main', taskText: '完整摘要与批准原文' } });
    expect(result.assets.map(a => a.id)).toEqual(['allowed']);
    expect(result.coverage.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain('disabled');
    expect(readableGate).toHaveBeenCalledWith(user, expect.any(Array), expect.objectContaining({ projectId: 'project-a', workspaceId: 'workspace-a', conversationKind: 'main', taskText: '完整摘要与批准原文' }));
    expect(readableGate).toHaveBeenLastCalledWith(user, [expect.objectContaining({ id: historical.id, statement: '旧正文', status: 'active' })], expect.any(Object));
  });
  it('without usable topic words falls back to recency and deterministic IDs; validates budgets', async () => {
    list.mockResolvedValue([asset('old', { updatedAt: '2025-01-01T00:00:00Z' }), asset('z'), asset('a')]);
    const result = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: '的 is and' }], maxAssets: 2 });
    expect(result.assets.map(a => a.id)).toEqual(['a', 'z']);
    for (const maxAssets of [0, -1, NaN, 1.5, 101]) await expect(selectCaptureExistingAssets(user, { maxAssets })).rejects.toThrow('invalid capture comparison budget');
  });
  it('embeds comparison candidates with bounded overlap instead of one serial round trip per record', async () => {
    list.mockResolvedValue(Array.from({ length: 8 }, (_, index) => asset('parallel-' + index)));
    let active = 0, peak = 0;
    embed.mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return [1, 0];
    });
    const result = await selectCaptureExistingAssets(user, { approvedEvidence: [{ quote: 'Pack travel accessories' }], maxAssets: 1 });
    expect(result.coverage.semantic).toBe('complete');
    expect(peak).toBeGreaterThan(1);
  });
});
