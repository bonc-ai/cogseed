/**
 * 探针（状态机审计员 · 新循环第 2 轮）：promoteRecallCandidate 把 LLM 起标题
 * 调用包在候选记录的 fileEditLock 内。
 *
 * 读码链：
 * - store.ts:129-131 updateRecallJsonRecord 在 fileEditLock(recordPath) 的
 *   runExclusive 里 await updater(current)——updater 的完整执行期都在锁内；
 * - candidate-service.ts:2472 promoteRecallCandidate 的 updater 是 async 大函数，
 *   :2603/:2692 在其内部 await resolvePromotionAssetTitle；
 * - resolvePromotionAssetTitle（:609-621）标题不合规时动态 import
 *   suggestAbilityAssetTitle——asset-title-suggestion.ts 是真实 LLM 调用
 *   （buildRunner，默认 3 次尝试，model_timeout 失败码）。
 *
 * 后果：候选记录锁被持有整个模型调用期（秒级~数十秒）——同候选的并发操作
 * （重复确认、状态迁移）全部排队；模型挂起且超时不可靠时锁迟迟不释放
 * （busy 锁释放路径断链）。store 层其余全部调用方的 updater 都是同步/轻异步，
 * 这是唯一的锁内重 IO。
 *
 * 测法：mock suggestAbilityAssetTitle，在其内部对候选记录路径做
 * acquireWithTimeout 探测——若 LLM 调用发生在锁内，此刻该锁正被 promote 持有，
 * 探测必然超时。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const probe = vi.hoisted(() => ({
  candidatePath: '' as string,
  lockHeldDuringLlm: null as null | boolean,
}));

vi.mock('../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => {
    const { fileEditLock, acquireWithTimeout } = await import('../../src/main/util/locks');
    try {
      const release = await acquireWithTimeout(fileEditLock(probe.candidatePath), 150);
      release();
      probe.lockHeldDuringLlm = false; // 拿到了：LLM 调用在锁外
    } catch {
      probe.lockHeldDuringLlm = true; // 超时：锁正被 promote 的 updater 持有
    }
    return { title: '模型重起的样本标题' };
  },
}));

vi.mock('../../src/main/features/kb_embed', () => ({
  closeEmbedder: () => {},
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'user-a';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm2l-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('probe-sm2 › promote 锁内 LLM 起标题', () => {
  it('suggestAbilityAssetTitle 执行期间候选记录锁被 promote 持有（150ms 探测超时）', async () => {
    const candidates = await import('../../src/main/features/recall/candidate-service');
    // summary 与 judgment 首字相同 → prefix_overlap 不合规 → 走 LLM 兜底链。
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '评审结论必须写进决策日志再动架构。',
      summary: '评审结论必须写进决策日', // 首字与正文相同，天然命中标题闸门
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-sm2' }],
    });
    probe.candidatePath = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'candidates', `${candidate.id}.json`);
    probe.lockHeldDuringLlm = null;

    const promoted = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });

    // promote 全链成功（mock 标题生效），且锁探测证明 LLM 调用发生在锁内。
    expect(promoted.candidate.status).toBe('confirmed');
    expect(promoted.asset.title).toBe('模型重起的样本标题');
    expect(probe.lockHeldDuringLlm).toBe(true);
  });
});
