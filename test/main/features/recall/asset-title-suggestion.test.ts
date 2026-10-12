import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modelMocks = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  outputs: [] as string[],
  errorKind: null as null | 'auth' | 'rate_limit' | 'context_overflow' | 'timeout' | 'provider_error',
  buildCalls: [] as any[],
  runCalls: [] as any[],
}));

vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModelForUser: () => ({ configured: modelMocks.configured }),
  hasConfiguredModel: () => ({ configured: modelMocks.configured }),
  getConfiguredModelOAuthExpiredMessage: () => modelMocks.oauthExpired,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: vi.fn(async (input: any) => {
    modelMocks.buildCalls.push(input);
    return {
      providerId: 'anthropic',
      modelId: 'claude-test',
      turnEphemeral: '',
      runner: {
        run: async (runInput: any) => {
          modelMocks.runCalls.push(runInput);
          const index = Math.min(modelMocks.runCalls.length - 1, modelMocks.outputs.length - 1);
          const text = modelMocks.outputs.length ? modelMocks.outputs[Math.max(0, index)] : '';
          return {
            text,
            content: [],
            meta: {
              durationMs: 1,
              model: 'claude-test',
              provider: 'anthropic',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolLoops: 0,
              compactionCount: 0,
              ...(modelMocks.errorKind ? { error: { kind: modelMocks.errorKind, message: 'provider detail must not persist' } } : {}),
            },
          };
        },
      },
    };
  }),
}));

const STATEMENT = '遇到同类任务时，先列出已知与未知，再补齐缺口。';

async function suggest(options: { attempts?: number } = {}) {
  const { suggestAbilityAssetTitle } = await import('../../../../src/main/features/recall/asset-title-suggestion');
  return suggestAbilityAssetTitle('user-title-suggest', { statement: STATEMENT, type: 'rule' }, options);
}

beforeEach(() => {
  modelMocks.configured = true;
  modelMocks.oauthExpired = null;
  modelMocks.outputs = [];
  modelMocks.errorKind = null;
  modelMocks.buildCalls = [];
  modelMocks.runCalls = [];
});
afterEach(() => { vi.resetModules(); });

describe('suggestAbilityAssetTitle（LLM 起标题共享函数：statement+type → 合规标题）', () => {
  it('模型给出合规标题：返回前过 3.1 判定，提示词带正文与类型', async () => {
    modelMocks.outputs = ['{"title":"已知未知清单法"}'];
    const result = await suggest();
    expect(result.title).toBe('已知未知清单法');
    expect(modelMocks.runCalls).toHaveLength(1);
    expect(modelMocks.runCalls[0].message).toContain(STATEMENT);
    expect(modelMocks.runCalls[0].message).toContain('rule');
  });

  it('容错解析：markdown 围栏包裹的 JSON 照常接受', async () => {
    modelMocks.outputs = ['```json\n{"title":"已知未知清单法"}\n```'];
    await expect(suggest()).resolves.toMatchObject({ title: '已知未知清单法' });
  });

  it('首轮标题不合规（抄正文开头）：带失败原因重试，第二轮合规即返回', async () => {
    modelMocks.outputs = [
      '{"title":"遇到同类任务先列清单"}', // 与正文开头重复 → 不合规
      '{"title":"已知未知清单法"}',
    ];
    const result = await suggest();
    expect(result.title).toBe('已知未知清单法');
    expect(modelMocks.runCalls).toHaveLength(2);
    // 重试消息里带着具体不合格原因，模型才知道往哪改。
    expect(modelMocks.runCalls[1].message).toContain('不合格');
  });

  it('非 JSON 输出也按可重试处理，次数耗尽抛 invalid_model_output', async () => {
    modelMocks.outputs = ['我觉得这个资产讲的是列清单的方法。', '还是不想输出 JSON'];
    await expect(suggest()).rejects.toMatchObject({ code: 'invalid_model_output' });
    expect(modelMocks.runCalls).toHaveLength(3); // 默认 attempts=3
  });

  it('全部轮次标题都不合规：明示失败（invalid_model_output），不自行编标题', async () => {
    modelMocks.outputs = ['{"title":"遇到同类任务先列清单"}'];
    await expect(suggest({ attempts: 2 })).rejects.toMatchObject({ code: 'invalid_model_output' });
    expect(modelMocks.runCalls).toHaveLength(2);
  });

  it('模型未配置：预检即失败（model_not_configured），不触碰模型链', async () => {
    modelMocks.configured = false;
    await expect(suggest()).rejects.toMatchObject({ code: 'model_not_configured' });
    expect(modelMocks.buildCalls).toHaveLength(0);
  });

  it('模型授权失效：明示 model_auth_required 且不重试', async () => {
    modelMocks.oauthExpired = 'token expired';
    await expect(suggest()).rejects.toMatchObject({ code: 'model_auth_required' });
  });

  it('运行期 auth 错误同样明示失败、不消耗重试', async () => {
    modelMocks.errorKind = 'auth';
    await expect(suggest()).rejects.toMatchObject({ code: 'model_auth_required' });
    expect(modelMocks.runCalls).toHaveLength(1);
  });

  it('正文为空：这是调用方数据错误，不编标题也不调模型', async () => {
    const { suggestAbilityAssetTitle } = await import('../../../../src/main/features/recall/asset-title-suggestion');
    await expect(suggestAbilityAssetTitle('user-title-suggest', { statement: '   ', type: 'fact' }))
      .rejects.toMatchObject({ code: 'model_failed' });
    expect(modelMocks.buildCalls).toHaveLength(0);
  });
});
