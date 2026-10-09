// DeepSeek 直连（内置 provider 'deepseek'）配置单一口径回归。
//
// 2026-09-14 排查背景：预设（public_model_catalog）与适配器
// （buildDeepSeekModel）各维护一份窗口/输出表，同一个 id 两处数字不同
// （1,000,000/384,000 vs 1,048,576/32,768，未登记 id 静默兜到 131,072/8,192
// ——界面按预设显示 1M/384K，运行时按 131K/8K 预算）；且预设里混入两条直连
// 不存在的 v4.1 id（真机 400）。本文件钉住三件事：
//   1. 适配器对预设里每个 id 的输出 ≡ 预设（新增 id 自动纳入覆盖）
//   2. 直连预设只包含厂商实测可接受的 id（快照对照，杜绝死 id 回流）
//   3. 未登记 id 走保守兜底；聚合器别名（v4.1 系）元数据仍可解析

import { describe, expect, it } from 'vitest';
import { PUBLIC_PROVIDER_MODELS, publicModelAbilitiesFor } from '../../../src/main/model/public_model_catalog';
import { buildDeepSeekModel } from '../../../src/main/model/core-agent/external-providers';

// 2026-09-14 真机 auth.testConnection 逐 id 实测（provider=deepseek,
// profile=deepseek:dp）。只登记厂商接受的 id：
//   实测拒绝 deepseek-v4.1-pro / deepseek-v4.1-flash →
//   400 "The supported API model names are deepseek-flash, deepseek-v4-pro"
const VENDOR_ACCEPTED_DEEPSEEK_IDS = [
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
];

const asModel = (id: string) => buildDeepSeekModel(id) as unknown as {
  contextWindow: number; maxTokens: number; reasoning: boolean; input: string[];
};

describe('deepseek 直连：预设与适配器单一口径', () => {
  const preset = PUBLIC_PROVIDER_MODELS.deepseek || [];

  it('适配器对每个预设 id 的输出与预设逐项一致（窗口/输出/多模态）', () => {
    expect(preset.length).toBeGreaterThan(0);
    for (const entry of preset) {
      const model = asModel(entry.id);
      expect({ id: entry.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens })
        .toEqual({ id: entry.id, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens });
      expect({ id: entry.id, vision: model.input.includes('image') })
        .toEqual({ id: entry.id, vision: entry.vision === true });
    }
  });

  it('直连预设只包含厂商实测可接受的 id，v4.1 系不得回流', () => {
    for (const entry of preset) {
      expect(VENDOR_ACCEPTED_DEEPSEEK_IDS, entry.id).toContain(entry.id);
    }
    const ids = preset.map((model) => model.id);
    expect(ids).not.toContain('deepseek-v4.1-pro');
    expect(ids).not.toContain('deepseek-v4.1-flash');
    // 厂商公告且实测通过的 id 必须在列（此前预设缺 deepseek-flash）。
    expect(ids).toContain('deepseek-flash');
  });

  it('未登记 id 走保守兜底，聚合器别名元数据仍可解析', () => {
    const unknown = asModel('deepseek-something-new');
    expect(unknown.contextWindow).toBe(131072);
    expect(unknown.maxTokens).toBe(8192);
    // v4.1 只在聚合器命名空间有效：不广告为直连模型，但窗口/多模态口径保留，
    // 供自定义供应商与聚合器条目按 id 解析。
    expect(publicModelAbilitiesFor('deepseek-v4.1-flash'))
      .toMatchObject({ contextWindow: 1000000, maxTokens: 384000, vision: true });
    expect(publicModelAbilitiesFor('deepseek/deepseek-v4.1-flash').maxTokens).toBe(384000);
  });

  it('思考判定：V4 全系与 reasoner 为真，chat 与未知 id 为假', () => {
    for (const id of [
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4.1-pro',
      'deepseek-reasoner',
    ]) {
      expect({ id, reasoning: asModel(id).reasoning }).toEqual({ id, reasoning: true });
    }
    expect(asModel('deepseek-chat').reasoning).toBe(false);
    expect(asModel('deepseek-unknown-x').reasoning).toBe(false);
  });
});
