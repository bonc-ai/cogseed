/**
 * 入池正文闸门（2026-09-29 根治冗长正文）真函数级测试。
 *
 * 钉住的硬边界：
 *  - 合规正文零成本直通（改写器根本不被调）；
 *  - 机器线超长正文入池前先改写（落盘的是改写结果，非原文）；
 *  - 改写失败降级原文入池（不丢知识，只 warn）；
 *  - 忠实搬运线（rawStatement）与 manual origin 豁免——用户亲写/历史原文
 *    一个字不被机器碰；
 *  - 幂等：改写结果已合规，再过闸不再触发 LLM。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const rewriteMock = vi.fn(async () => ({ statement: '改写后的合规短正文。' }));
vi.mock('../../../../src/main/features/recall/asset-statement-rewrite', () => ({
  suggestAbilityAssetStatement: rewriteMock,
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  rewriteMock.mockClear();
  rewriteMock.mockImplementation(async () => ({ statement: '改写后的合规短正文。' }));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cand-gate-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

const LONG_DIRTY = `候选正文闸门根治测试用超长正文：这一段故意超过两百字硬限，并且带上会话一次性标识 turn-3f9a2b1c4d5e 与本机路径 /Users/an/src/foo.ts，命中 too_long、session_debris、local_path 三种机器可判问题，用来验证入池前的预处置是否真的把这类机器生成的脏正文交给改写器清洗后再落盘，而不是原样进池等事后治理轮来擦屁股。`.repeat(1);

async function loadGate() {
  return import('../../../../src/main/features/recall/candidate-statement-gate');
}
async function loadCandidateService() {
  return import('../../../../src/main/features/recall/candidate-service');
}
const baseInput = (judgment: string) => ({
  judgment,
  suggestedType: 'rule' as const,
  suggestedScope: 'general',
  suggestedAction: 'create' as const,
  sourceRefs: [{ kind: 'conversation' as const, id: 'conv-gate-test' }],
  evidenceRefs: [{ kind: 'conversation' as const, id: 'conv-gate-test' }],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

describe('入池正文闸门（gateCandidateStatement）', () => {
  it('合规正文直通：改写器不被调', async () => {
    const { gateCandidateStatement } = await loadGate();
    const clean = '部署前先跑一遍冒烟清单，任何一步失败都停下来排查。';
    const out = await gateCandidateStatement('u-gate', { judgment: clean, suggestedType: 'rule' });
    expect(out).toBe(clean);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it('超长带痕迹正文先改写：返回改写结果', async () => {
    const { gateCandidateStatement } = await loadGate();
    const out = await gateCandidateStatement('u-gate', { judgment: LONG_DIRTY, suggestedType: 'rule' });
    expect(out).toBe('改写后的合规短正文。');
    expect(rewriteMock).toHaveBeenCalledTimes(1);
    // 改写器拿到的类型与正文正确对位。
    expect(rewriteMock.mock.calls[0][1]).toMatchObject({ statement: LONG_DIRTY, type: 'rule' });
  });

  it('改写失败降级原文：不丢知识', async () => {
    const { gateCandidateStatement } = await loadGate();
    rewriteMock.mockRejectedValueOnce(new Error('model_not_configured'));
    const out = await gateCandidateStatement('u-gate', { judgment: LONG_DIRTY, suggestedType: 'rule' });
    expect(out).toBe(LONG_DIRTY);
  });

  it('skip 豁免：忠实搬运线一个字不碰', async () => {
    const { gateCandidateStatement } = await loadGate();
    const out = await gateCandidateStatement('u-gate', { judgment: LONG_DIRTY, suggestedType: 'rule', skip: true });
    expect(out).toBe(LONG_DIRTY);
    expect(rewriteMock).not.toHaveBeenCalled();
  });
});

describe('saveRecallCandidate 收口集成', () => {
  it('机器线超长 judgment：落盘的是改写结果', async () => {
    const svc = await loadCandidateService();
    const saved = await svc.saveRecallCandidate('u-gate', baseInput(LONG_DIRTY));
    expect(saved.judgment).toBe('改写后的合规短正文。');
    expect(rewriteMock).toHaveBeenCalledTimes(1);
  });

  it('manual（记一条）豁免：用户亲写原文落盘', async () => {
    const svc = await loadCandidateService();
    const saved = await svc.saveRecallCandidate('u-gate', { ...baseInput(LONG_DIRTY), manual: true });
    expect(saved.judgment).toBe(LONG_DIRTY);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it('rawStatement 豁免：旧记忆迁移原文落盘', async () => {
    const svc = await loadCandidateService();
    const saved = await svc.saveRecallCandidate('u-gate', { ...baseInput(LONG_DIRTY), rawStatement: true });
    expect(saved.judgment).toBe(LONG_DIRTY);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it('改写失败降级：原文入池不阻断', async () => {
    const svc = await loadCandidateService();
    rewriteMock.mockRejectedValueOnce(new Error('model_timeout'));
    const saved = await svc.saveRecallCandidate('u-gate', baseInput(LONG_DIRTY));
    expect(saved.judgment).toBe(LONG_DIRTY);
  });

  it('幂等：已合规正文再入池不触发改写', async () => {
    const svc = await loadCandidateService();
    await svc.saveRecallCandidate('u-gate', baseInput('部署前先跑一遍冒烟清单，任何一步失败都停下来排查。'));
    expect(rewriteMock).not.toHaveBeenCalled();
  });
});
