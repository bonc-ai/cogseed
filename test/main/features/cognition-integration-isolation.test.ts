import { describe, expect, it, vi } from 'vitest';
import { cognitionIntegrationIsolated, isKstarCognitionSource } from '../../../src/main/features/cognition/integration-boundary';
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
describe('KSTAR 不进入普通认知的硬边界', () => {
  it('无用户启用开关，识别当前和历史来源标记', () => {
    expect(cognitionIntegrationIsolated()).toBe(true);
    expect(isKstarCognitionSource({ sourceRefs: [{ kind: 'execution', id: 'kse-old' }] })).toBe(true);
    expect(isKstarCognitionSource({ evidenceRefs: [{ id: 'kse-old' }] })).toBe(true);
    expect(isKstarCognitionSource({ learningSignal: { source: 'review' } })).toBe(true);
    expect(isKstarCognitionSource({ sourceRefs: [{ kind: 'conversation', id: 'chat-a' }] })).toBe(false);
  });
  it('两种生产桥返回零候选、零资产、零经验，不需要读取普通认知', async () => {
    const { saveKstarCandidateProposals } = await import('../../../src/main/features/kstar/recall-bridge');
    const { precipitateDirectExperienceFromSource, precipitateDirectExperienceAssets } = await import('../../../src/main/features/kstar/direct-experience-assets');
    expect(await saveKstarCandidateProposals('u1', [{}] as never)).toEqual([]);
    const result = await precipitateDirectExperienceFromSource('u1', { id: 'source-a' }, [{}] as never, {} as never, {} as never);
    expect(result).toEqual({ createdAssetIds: [], candidateIds: [], experienceIds: [], mergedIntoIds: [], updateCandidateIds: [], failureIds: [] });
    expect(await precipitateDirectExperienceAssets('u1', { id: 'episode-a' } as never, [{}] as never)).toEqual(result);
  });
  it('预测分支不再读取共同认知，缺少旧投影也不要求普通任务等待', async () => {
    const { autoForecastForRequirement } = await import('../../../src/main/features/kstar/auto-forecast');
    const result = await autoForecastForRequirement('u1', 'chat-a', 'req-a');
    expect(result).toMatchObject({ ok: false, reason: 'ordinary cognition integration isolated' });
  });
  it('直接绕过生产桥写共同候选也被阻止', async () => {
    const { submitCognitionCandidate } = await import('../../../src/main/features/cognition/candidate-submission');
    await expect(submitCognitionCandidate('u1', { sourceRefs: [{ kind: 'execution', id: 'kse-legacy' }] } as never)).rejects.toThrow('integration isolated');
  });
});
