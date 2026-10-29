/**
 * 推理强度 Option C（按模型声明的能力）——纯策略判定。
 *
 * 这一层是渲染层菜单与后端 preflight **共用的唯一口径**：菜单只列这里返回的档位，
 * 后端调用前用同一个判定拒绝越档（落 model_preflight）。两处各写一份必然漂移，
 * 所以这里把「声明」和「拒绝」的边界都钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  HOST_REASONING_LEVELS,
  declaredReasoningLevelsFromCustomDeclarations,
  declaredReasoningLevelsFromPiModel,
  validateReasoningEffort,
} from '../../../src/main/model/reasoning_effort';

describe('validateReasoningEffort（后端调用前的安全门）', () => {
  it('⭐ 产品决策包的契约样例：声明只有 low/medium 时要 high 被安全拒绝', () => {
    expect(validateReasoningEffort({ model: 'model-a', supported: ['low', 'medium'], requested: 'high' }))
      .toEqual({ ok: false, code: 'model_preflight' });
  });

  it('声明里的档位放行', () => {
    expect(validateReasoningEffort({ model: 'model-a', supported: ['low', 'high'], requested: 'low' }))
      .toEqual({ ok: true });
  });

  it.each([undefined, null, '', 'auto'])('⭐ Auto（%s）不选档位 → 省略 effort，直接放行', (requested) => {
    expect(validateReasoningEffort({ model: 'model-a', supported: ['low'], requested }))
      .toEqual({ ok: true });
  });

  it('⚠️ off 永远放行：它的语义是「不发参数」，不是「发 off 给 provider」', () => {
    // 110+ 个 pi 目录模型把 off 标成 null（不能关闭推理）。若这里拒绝，全局
    // 「关闭思考」偏好会让这些模型的每个回合都以 model_preflight 失败。
    expect(validateReasoningEffort({ model: 'model-a', supported: ['low', 'high'], requested: 'off' }))
      .toEqual({ ok: true });
    expect(validateReasoningEffort({ model: 'model-a', supported: [], requested: 'off' }))
      .toEqual({ ok: true });
    expect(validateReasoningEffort({ model: 'model-a', requested: 'off' }))
      .toEqual({ ok: true });
  });

  it('宿主表达不了的取值（如 pi 的 xhigh）一律拒绝，不就近降级', () => {
    expect(validateReasoningEffort({ requested: 'xhigh' })).toEqual({ ok: false, code: 'model_preflight' });
    expect(validateReasoningEffort({ requested: 'medium' })).toEqual({ ok: false, code: 'model_preflight' });
  });

  it('⚠️ 解析不出声明时**不拒绝**——"不知道"不是"不支持"', () => {
    expect(validateReasoningEffort({ model: 'model-a', supported: null, requested: 'high' }))
      .toEqual({ ok: true });
    expect(validateReasoningEffort({ model: 'model-a', requested: 'high' }))
      .toEqual({ ok: true });
  });

  it('声明为空数组是明确的"没有可用档位" → 拒绝', () => {
    expect(validateReasoningEffort({ model: 'model-a', supported: [], requested: 'low' }))
      .toEqual({ ok: false, code: 'model_preflight' });
  });
});

describe('declaredReasoningLevelsFromPiModel（pi 目录声明）', () => {
  it('reasoning !== true 的模型没有任何档位（只显示 Auto）', () => {
    expect(declaredReasoningLevelsFromPiModel({ reasoning: false })).toEqual([]);
    expect(declaredReasoningLevelsFromPiModel({})).toEqual([]);
    expect(declaredReasoningLevelsFromPiModel(null)).toEqual([]);
  });

  it('reasoning === true 且无 thinkingLevelMap → 宿主三档全支持', () => {
    expect(declaredReasoningLevelsFromPiModel({ reasoning: true })).toEqual(['off', 'low', 'high']);
  });

  it('⭐ thinkingLevelMap 里显式为 null 的档位不得暴露（pi-ai 的"不支持"标记）', () => {
    expect(declaredReasoningLevelsFromPiModel({
      reasoning: true,
      thinkingLevelMap: { off: null, high: 'max' },
    })).toEqual(['low', 'high']);
  });

  it('thinkingLevelMap 只声明了别的档位（xhigh）不影响宿主三档', () => {
    expect(declaredReasoningLevelsFromPiModel({
      reasoning: true,
      thinkingLevelMap: { xhigh: 'max' },
    })).toEqual(['off', 'low', 'high']);
  });
});

describe('declaredReasoningLevelsFromCustomDeclarations（自定义 provider 声明）', () => {
  it('reasoningLevels 与 reasoningParamsMap 的键都算声明', () => {
    expect(declaredReasoningLevelsFromCustomDeclarations({ reasoningLevels: ['low', 'high'] }))
      .toEqual(['low', 'high']);
    expect(declaredReasoningLevelsFromCustomDeclarations({ reasoningParamsMap: { high: { reasoning_effort: 'high' } } }))
      .toEqual(['high']);
  });

  it('⚠️ 认不出的取值不会就近映射成宿主档位', () => {
    expect(declaredReasoningLevelsFromCustomDeclarations({ reasoningLevels: ['minimal', 'xhigh'] }))
      .toEqual([]);
    expect(declaredReasoningLevelsFromCustomDeclarations({ reasoningLevels: ['HIGH'] }))
      .toEqual(['high']);
  });

  it('没有声明 → 空（只显示 Auto）', () => {
    expect(declaredReasoningLevelsFromCustomDeclarations({})).toEqual([]);
    expect(declaredReasoningLevelsFromCustomDeclarations(null)).toEqual([]);
  });

  it('档位顺序固定为宿主顺序，菜单不会因声明顺序漂移', () => {
    expect(HOST_REASONING_LEVELS).toEqual(['off', 'low', 'high']);
    expect(declaredReasoningLevelsFromCustomDeclarations({ reasoningLevels: ['high', 'off'] }))
      .toEqual(['off', 'high']);
  });
});
