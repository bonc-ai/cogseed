import { describe, it, expect } from 'vitest';
import { loadEngine } from '../../../../src/main/features/evolution/engine-loader';

describe('engine-loader', () => {
  it('动态 import 引擎并暴露 EvolutionOrchestrator / OntologyWriter / KSTAR_STEPS', async () => {
    const engine = await loadEngine();
    expect(engine.EvolutionOrchestrator).toBeTypeOf('function');
    expect(engine.OntologyWriter).toBeTypeOf('function');
    expect(engine.KSTAR_STEPS).toBeDefined();
    expect(engine.ruleFallbackComplete).toBeTypeOf('function');
  });

  it('重复调用返回同一缓存句柄', async () => {
    const a = await loadEngine();
    const b = await loadEngine();
    expect(a).toBe(b);
  });
});
