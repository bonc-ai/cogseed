// 模型识别模块（B 层）契约：pi-ai 目录精确/去前缀命中 + 家族规则兜底 +
// 完全未知返回 null。目录答案带窗口真值；家族答案只给能力、绝不编数字。

import { afterEach, describe, expect, it } from 'vitest';
import {
  recognizeModelById,
  recognizeModelByIdReady,
  ensureModelRecognitionReady,
  _resetModelRecognitionForTest,
} from '../../../src/main/model/model_id_recognition';

afterEach(() => {
  _resetModelRecognitionForTest();
});

describe('model_id_recognition › family rules (synchronous)', () => {
  it('recognizes well-known families with capability flags only', () => {
    const claude = recognizeModelById('claude-sonnet-5-somehost');
    expect(claude).toMatchObject({ source: 'family', reasoning: true, vision: true });
    expect(claude?.contextWindow).toBeUndefined(); // 家族规则绝不编窗口数字

    const dsVision = recognizeModelById('deepseek-v4-flash-vision-exp');
    expect(dsVision).toMatchObject({ reasoning: true, vision: true });
    const dsText = recognizeModelById('deepseek-v4-flash');
    expect(dsText).toMatchObject({ reasoning: true, vision: false });

    // gemini：视觉开；推理只在 pro/thinking 变体。
    expect(recognizeModelById('gemini-3-pro')?.reasoning).toBe(true);
    expect(recognizeModelById('gemini-3-flash')?.reasoning).toBe(false);
  });

  it('strips relay-style id prefixes before family matching', () => {
    expect(recognizeModelById('deepseek/deepseek-v4-flash')?.reasoning).toBe(true);
    expect(recognizeModelById('accounts/fireworks/models/claude-sonnet-5-x')?.reasoning).toBe(true);
  });

  it('returns null for unrecognizable ids', () => {
    expect(recognizeModelById('my-private-finetune-v1')).toBeNull();
    expect(recognizeModelById('')).toBeNull();
  });
});

describe('model_id_recognition › catalog (async, authoritative)', () => {
  it('resolves catalog ids with real window sizes', async () => {
    await ensureModelRecognitionReady();
    // pi-ai 目录内任意已知模型（选一个稳定的 claude 条目，允许变体存在）。
    const hit = await recognizeModelByIdReady('claude-3-5-sonnet-20240620');
    expect(hit).not.toBeNull();
    expect(hit?.source).toBe('catalog');
    expect(hit?.reasoning).toBe(false);
    expect(hit?.vision).toBe(true);
    expect(typeof hit?.contextWindow).toBe('number');
  });

  it('falls back to family rules when the catalog misses', async () => {
    await ensureModelRecognitionReady();
    const hit = await recognizeModelByIdReady('deepseek/deepseek-v9-future');
    expect(hit).toMatchObject({ source: 'family', reasoning: true });
  });
});
